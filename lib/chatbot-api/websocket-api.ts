import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Effect } from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import * as path from "path";
import { Shared } from "../shared";
import { Direction } from "../shared/types";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cognitoIdentityPool from "@aws-cdk/aws-cognito-identitypool-alpha";
import * as pylambda from "@aws-cdk/aws-lambda-python-alpha";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import * as ec2 from "aws-cdk-lib/aws-ec2";

interface WebSocketApiProps {
  readonly shared: Shared;
  readonly userPool: cognito.UserPool;
  readonly identityPool: cognitoIdentityPool.IdentityPool;
}

export class WebSocketApi extends Construct {
  public readonly api: appsync.GraphqlApi;
  public readonly messagesTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: WebSocketApiProps) {
    super(scope, id);

    // Create the main Message Topic acting as a message bus
    const messagesTopic = new sns.Topic(this, "MessagesTopic");
    /**
     * AppSync API for websockets
     */

    const graphqlApi = new appsync.GraphqlApi(this, "Api", {
      name: "WebsocketApi",
      visibility: appsync.Visibility.PRIVATE,
      definition: appsync.Definition.fromFile(path.join(__dirname, "graphql-api", "schema.graphql")),
      logConfig: {
        role: new iam.Role(this, "WebSocketApiLogRole", {
          assumedBy: new iam.ServicePrincipal("appsync.amazonaws.com"),
          inlinePolicies: {
            CloudwatchLogs: new iam.PolicyDocument({
              statements: [new iam.PolicyStatement({
                actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
                effect: Effect.ALLOW,
                resources: ["*"]
              })]
            })
          }
        }),
        retention: RetentionDays.THREE_DAYS
      },
      authorizationConfig: {
        defaultAuthorization: {
          authorizationType: appsync.AuthorizationType.USER_POOL,
          userPoolConfig: {
            userPool: props.userPool,
          }
        },
        additionalAuthorizationModes: [{
          authorizationType: appsync.AuthorizationType.IAM,
        }]
      },
      xrayEnabled: true
    });

    props.shared.vpc.addInterfaceEndpoint("AppsyncEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.APP_SYNC,
      open: true
    })

    const incomingMessageHandlerFunction = new lambda.Function(
      this,
      "IncomingMessageHandlerFunction",
      {
        code: lambda.Code.fromAsset(
          path.join(__dirname, "./functions/incoming-message-handler")
        ),
        handler: "index.handler",
        runtime: props.shared.pythonRuntime,
        architecture: props.shared.lambdaArchitecture,
        tracing: lambda.Tracing.ACTIVE,
        layers: [props.shared.powerToolsLayer],
        environment: {
          ...props.shared.defaultEnvironmentVariables,
          MESSAGES_TOPIC_ARN: messagesTopic.topicArn,
        },
      }
    );

    messagesTopic.grantPublish(incomingMessageHandlerFunction);
    incomingMessageHandlerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["events:PutEvents"],
        resources: [
          `arn:${cdk.Aws.PARTITION}:events:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:event-bus/default`,
        ],
      })
    );


    const outgoingMessageHandlerFunction = new pylambda.PythonFunction(
      this,
      "OutgoingMessageFunction",
      {
        vpc: props.shared.vpc,
        vpcSubnets: props.shared.vpc.privateSubnets as ec2.SubnetSelection,
        entry: path.join(__dirname, 'functions', 'outgoing-message-handler'),
        index: 'index.py',
        handler: "handler",
        runtime: props.shared.pythonRuntime,
        architecture: props.shared.lambdaArchitecture,
        tracing: lambda.Tracing.ACTIVE,
        layers: [props.shared.powerToolsLayer],
        environment: {
          ...props.shared.defaultEnvironmentVariables,
          APPSYNC_URL: graphqlApi.graphqlUrl,
        },
      }
    );

    graphqlApi.grantMutation(outgoingMessageHandlerFunction)


    const noneDataSource = graphqlApi.addNoneDataSource('none');
    const incomingMessageDataSource = graphqlApi.addLambdaDataSource('IncomingMessageLambda', incomingMessageHandlerFunction);
    const func_localResolver = new appsync.AppsyncFunction(this, 'LocalResolver', {
      name: 'LocalResolver',
      api: graphqlApi,
      dataSource: noneDataSource,
      code: appsync.Code.fromAsset(path.join(__dirname, 'graphql-api', 'resolvers', 'localResolver.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,

    });

    const subscriptionResolver = new appsync.Resolver(this, "SubscriptionResolver", {
      api: graphqlApi,
      typeName: "Subscription",
      fieldName: "onMessage",
      dataSource: noneDataSource,
      code: appsync.Code.fromAsset(path.join(__dirname, 'graphql-api', 'resolvers', 'subscriptionResolver.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    const sendMessageResolver = new appsync.Resolver(this, "SendMessageResolver", {
      api: graphqlApi,
      typeName: "Mutation",
      fieldName: "sendMessage",
      dataSource: incomingMessageDataSource,
      code: appsync.Code.fromAsset(path.join(__dirname, 'graphql-api', 'resolvers', 'incomingMessageResolver.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
    });

    const sendMessageToClientResolver = new appsync.Resolver(this, "SendMessageToClientResolver", {
      api: graphqlApi,
      typeName: "Mutation",
      fieldName: "sendMessageToClient",
      code: appsync.Code.fromAsset(path.join(__dirname, 'graphql-api', 'resolvers', 'passthrough.js')),
      runtime: appsync.FunctionRuntime.JS_1_0_0,
      pipelineConfig: [func_localResolver]
    });

    const deadLetterQueue = new sqs.Queue(this, "OutgoingMessagesDLQ");

    const queue = new sqs.Queue(this, "OutgoingMessagesQueue", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: 3,
      },
    });

    // grant eventbridge permissions to send messages to the queue
    queue.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["sqs:SendMessage"],
        resources: [queue.queueArn],
        principals: [
          new iam.ServicePrincipal("events.amazonaws.com"),
          new iam.ServicePrincipal("sqs.amazonaws.com"),
        ],
      })
    );

    outgoingMessageHandlerFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(queue)
    );

    // Route all outgoing messages to the websocket interface queue
    messagesTopic.addSubscription(
      new subscriptions.SqsSubscription(queue, {
        filterPolicyWithMessageBody: {
          direction: sns.FilterOrPolicy.filter(
            sns.SubscriptionFilter.stringFilter({
              allowlist: [Direction.Out],
            })
          ),
        },
      })
    );

    this.api = graphqlApi
    this.messagesTopic = messagesTopic;
  }
}
