import json

from aws_lambda_powertools import Logger, Tracer
from aws_lambda_powertools.utilities.batch import BatchProcessor, EventType
from aws_lambda_powertools.utilities.batch.exceptions import BatchProcessingError
from aws_lambda_powertools.utilities.data_classes.sqs_event import SQSRecord
from aws_lambda_powertools.utilities.typing import LambdaContext

import appsync

processor = BatchProcessor(event_type=EventType.SQS)
tracer = Tracer()
logger = Logger()

sendMessageToClientMutation = """
mutation sendMessageToClient($userId: String!, $connectionId: String!, $body: String!) {
  sendMessageToClient(userId: $userId, connectionId: $connectionId, body: $body) {
    userId
    connectionId
    body
  }
}
"""


@tracer.capture_method
def record_handler(record: SQSRecord):
    payload: str = record.body
    message: dict = json.loads(payload)
    detail: dict = json.loads(message["Message"])
    logger.info(detail)
    user_id = detail["userId"]
    connection_id = detail["connectionId"]

    # get current connectionIds
    try:
        appsync.query(sendMessageToClientMutation, {"userId": user_id, "connectionId": connection_id, "body": json.dumps(detail)})
    except Exception as e:
        logger.info(
            f"Exception while sending message to connection {connection_id} for user {user_id}: {e}"
        )


@logger.inject_lambda_context(log_event=True)
@tracer.capture_lambda_handler
def handler(event, context: LambdaContext):
    batch = event["Records"]
    try:
        with processor(records=batch, handler=record_handler):
            processed_messages = processor.process()
    except BatchProcessingError as e:
        logger.error(e)

    logger.info(processed_messages)
    return processor.response()
