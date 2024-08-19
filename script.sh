#!/bin/bash



gcloud config set project fyre-400407  

gcloud container clusters get-credentials hypermine-gke --region asia-south1

node src/index.js