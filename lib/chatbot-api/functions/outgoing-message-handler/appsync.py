import os

import boto3
import requests
from aws_lambda_powertools import Logger, Tracer
from requests_aws_sign import AWSV4Sign

logger = Logger()
tracer = Tracer()

APPSYNC_URL = os.getenv("APPSYNC_URL")


@tracer.capture_method
def query(query: str, variables: dict):
    session = boto3.session.Session()
    credentials = session.get_credentials()

    endpoint = APPSYNC_URL

    headers = {"Content-Type": "application/json"}
    payload = {"query": query, "variables": variables}

    appsync_region = __parse_region_from_url(endpoint) or "eu-central-1"
    auth = AWSV4Sign(credentials, appsync_region, "appsync")
    try:
        response = requests.post(
            endpoint, auth=auth, json=payload, headers=headers
        ).json()
        if "errors" in response:
            logger.error(
                "Error attempting to query AppSync",
                extra={"payload": payload, "response": response},
            )
        else:
            logger.info(
                "AppSync response", extra={"payload": payload, "response": response}
            )
            return response
    except Exception as exception:
        logger.error(
            "Exception while querying AppSync",
            extra={"payload": payload, "exception": exception},
        )

    return None


def __parse_region_from_url(url):
    # Example URL: https://xxxxxxx.appsync-api.us-east-2.amazonaws.com/graphql
    split = url.split(".")
    if 2 < len(split):
        return split[2]
    return None
