import * as apigwv2 from "@aws-cdk/aws-apigatewayv2-alpha";
import * as cognitoIdentityPool from "@aws-cdk/aws-cognito-identitypool-alpha";
import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as appsync from "aws-cdk-lib/aws-appsync";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import {
  ExecSyncOptionsWithBufferEncoding,
  execSync,
} from "node:child_process";
import * as path from "node:path";
import { Shared } from "../shared";
import { SystemConfig } from "../shared/types";
import { Utils } from "../shared/utils";
import { ChatBotApi } from "../chatbot-api/index";
import { Stack } from "aws-cdk-lib";

export interface UserInterfaceProps {
  readonly config: SystemConfig;
  readonly shared: Shared;
  readonly userPoolId: string;
  readonly userPoolClientId: string;
  readonly identityPool: cognitoIdentityPool.IdentityPool;
  readonly chatbotApi: ChatBotApi;
  readonly webSocketApi: appsync.GraphqlApi;
  readonly chatbotFilesBucket: s3.Bucket;
  readonly crossEncodersEnabled: boolean;
  readonly sagemakerEmbeddingsEnabled: boolean;
}

export class UserInterface extends Construct {
  constructor(scope: Construct, id: string, props: UserInterfaceProps) {
    super(scope, id);

    const appPath = path.join(__dirname, "react-app");
    const buildPath = path.join(appPath, "dist");

    const websiteBucket = new s3.Bucket(this, "WebsiteBucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      autoDeleteObjects: true,
      websiteIndexDocument: "index.html",
      websiteErrorDocument: "index.html",
    });

    const frontendApiS3IntegrationRole = new iam.Role(this, "ApiGatewayS3IntegrationRole", {
      assumedBy: new iam.ServicePrincipal("apigateway.amazonaws.com")
    })
    frontendApiS3IntegrationRole.addToPolicy(new iam.PolicyStatement({
      resources: [websiteBucket.bucketArn],
      actions: ["s3:GetObject"]
    }))
    websiteBucket.grantRead(frontendApiS3IntegrationRole);

    // Redirect / to /app/
    props.chatbotApi.restApi.root.addMethod("GET", new apigateway.MockIntegration({
      passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
      contentHandling: apigateway.ContentHandling.CONVERT_TO_TEXT,
      requestTemplates: {
        "application/json": "{\"statusCode\": 301}"
      },
      integrationResponses: [
        {
          statusCode: "301",
          responseParameters: {
            "method.response.header.Location": "'app/'"
  }
        }
      ]
    }), {
      methodResponses: [
        {
          statusCode: "301",
          responseParameters: {
            "method.response.header.Location": true
          }
        }
      ]
    })
    const appResource = props.chatbotApi.restApi.root.addResource("app")

    // Serve index.html when /app/ is requested
    appResource.addMethod("GET",
      new apigateway.AwsIntegration({
        service: "s3",
        integrationHttpMethod: "GET",
        path: `${websiteBucket.bucketName}/index.html`,
        options: {
          credentialsRole: frontendApiS3IntegrationRole,
          integrationResponses: [
            {
              statusCode: "200",
              responseParameters: {
                "method.response.header.Content-Type": "integration.response.header.Content-Type",
              }
            }
          ]
        }
      }),
      {
        methodResponses: [
          {
            statusCode: "200",
            responseParameters: {
              "method.response.header.Content-Type": true,
            },
          },
        ],
        requestParameters: {
          "method.request.path.key": true,
          "method.request.header.Content-Type": true,
        },
      }
    )


    appResource.addResource("{key+}")
      .addMethod("GET",
        new apigateway.AwsIntegration({
          service: "s3",
          integrationHttpMethod: "GET",
          path: `${websiteBucket.bucketName}/{key}`,
          options: {
            credentialsRole: frontendApiS3IntegrationRole,
            integrationResponses: [
              {
                statusCode: "200",
                responseParameters: {
                  "method.response.header.Content-Type": "integration.response.header.Content-Type",
                }
              }
            ],
            requestParameters: {
              "integration.request.path.key": "method.request.path.key",
            },
          }
        }),
        {
          methodResponses: [
            {
              statusCode: "200",
              responseParameters: {
                "method.response.header.Content-Type": true,
              },
            },
          ],
          requestParameters: {
            "method.request.path.key": true,
            "method.request.header.Content-Type": true,
          },
        }
      )


    const exportsAsset = s3deploy.Source.jsonData("aws-exports.json", {
      aws_project_region: cdk.Aws.REGION,
      aws_cognito_region: cdk.Aws.REGION,
      aws_user_pools_id: props.userPoolId,
      aws_user_pools_web_client_id: props.userPoolClientId,
      aws_cognito_identity_pool_id: props.identityPool.identityPoolId,
      aws_appsync_graphqlEndpoint: props.webSocketApi.graphqlUrl,
      aws_appsync_region: Stack.of(this).region,
      aws_appsync_authenticationType: 'AMAZON_COGNITO_USER_POOLS',
      Storage: {
        AWSS3: {
          bucket: props.chatbotFilesBucket.bucketName,
          region: cdk.Aws.REGION,
        },
      },
      config: {
        api_endpoint: `${props.chatbotApi.restApi.url}api`,
        rag_enabled: props.config.rag.enabled,
        cross_encoders_enabled: props.crossEncodersEnabled,
        sagemaker_embeddings_enabled: props.sagemakerEmbeddingsEnabled,
        default_embeddings_model: Utils.getDefaultEmbeddingsModel(props.config),
        default_cross_encoder_model: Utils.getDefaultCrossEncoderModel(
          props.config
        ),
      },
    });

    // Allow authenticated web users to read upload data to the attachments bucket for their chat files
    // ref: https://docs.amplify.aws/lib/storage/getting-started/q/platform/js/#using-amazon-s3
    props.identityPool.authenticatedRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        resources: [
          `${props.chatbotFilesBucket.bucketArn}/public/*`,
          `${props.chatbotFilesBucket.bucketArn}/protected/\${cognito-identity.amazonaws.com:sub}/*`,
          `${props.chatbotFilesBucket.bucketArn}/private/\${cognito-identity.amazonaws.com:sub}/*`,
        ],
      })
    );
    props.identityPool.authenticatedRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["s3:ListBucket"],
        resources: [`${props.chatbotFilesBucket.bucketArn}`],
        conditions: {
          StringLike: {
            "s3:prefix": [
              "public/",
              "public/*",
              "protected/",
              "protected/*",
              "private/${cognito-identity.amazonaws.com:sub}/",
              "private/${cognito-identity.amazonaws.com:sub}/*",
            ],
          },
        },
      })
    );

    // Enable CORS for the attachments bucket to allow uploads from the user interface
    // ref: https://docs.amplify.aws/lib/storage/getting-started/q/platform/js/#amazon-s3-bucket-cors-policy-setup
    props.chatbotFilesBucket.addCorsRule({
      allowedMethods: [
        s3.HttpMethods.GET,
        s3.HttpMethods.PUT,
        s3.HttpMethods.POST,
        s3.HttpMethods.DELETE,
      ],
      allowedOrigins: ["*"],
      allowedHeaders: ["*"],
      exposedHeaders: [
        "x-amz-server-side-encryption",
        "x-amz-request-id",
        "x-amz-id-2",
        "ETag",
      ],
      maxAge: 3000,
    });

    const asset = s3deploy.Source.asset(appPath, {
      bundling: {
        image: cdk.DockerImage.fromRegistry(
          "public.ecr.aws/sam/build-nodejs18.x:latest"
        ),
        command: [
          "sh",
          "-c",
          [
            "npm --cache /tmp/.npm install",
            `BASE="${props.chatbotApi.restApiStageName}/app" npm --cache /tmp/.npm run build`,
            "cp -aur /asset-input/dist/* /asset-output/",
          ].join(" && "),
        ],
        local: {
          tryBundle(outputDir: string) {
            try {
              const options: ExecSyncOptionsWithBufferEncoding = {
                stdio: "inherit",
                env: {
                  ...process.env,
                },
              };

              execSync(`npm --silent --prefix "${appPath}" ci`, options);
              execSync(`BASE="${props.chatbotApi.restApiStageName}/app" npm --silent --prefix "${appPath}" run build`, options);
              Utils.copyDirRecursive(buildPath, outputDir);
            } catch (e) {
              console.error(e);
              return false;
            }

            return true;
          },
        },
      },
    });

    new s3deploy.BucketDeployment(this, "UserInterfaceDeployment", {
      prune: false,
      sources: [asset, exportsAsset],
      destinationBucket: websiteBucket,
    });
  }
}
