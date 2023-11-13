import json
import os
from datetime import datetime

import boto3
from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.typing import LambdaContext

tracer = Tracer()
logger = Logger(log_uncaught_exceptions=True)
sns = boto3.client("sns", region_name=os.environ["AWS_REGION"])



def handle_message(connection_id, user_id, body):
    action = body["action"]
    model_interface = body.get("modelInterface", "langchain")
    data = body.get("data", {})

    return handle_request(connection_id, user_id, action, model_interface, data)


def handle_request(connection_id, user_id, action, model_interface, data):
    message = {
        "action": action,
        "modelInterface": model_interface,
        "direction": "IN",
        "connectionId": connection_id,
        "timestamp": str(int(round(datetime.now().timestamp()))),
        "userId": user_id,
        "data": data,
    }
    logger.info(message)
    response = sns.publish(
        TopicArn=os.environ["MESSAGES_TOPIC_ARN"],
        Message=json.dumps(message),
    )

    return True


@tracer.capture_lambda_handler
@logger.inject_lambda_context(log_event=True)
def handler(event, context: LambdaContext):
    logger.info("New invoke", event)
    connection_id = event["connectionId"]
    user_id = event["userId"]
    logger.set_correlation_id(connection_id)
    tracer.put_annotation(key="ConnectionId", value=connection_id)
    tracer.put_annotation(key="UserId", value=user_id)

    message = json.loads(event["body"])
    return handle_message(connection_id, user_id, message)
