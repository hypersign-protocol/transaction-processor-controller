#!/bin/bash

gcloud auth login --cred-file=/data/fyre-400407-9c9f737ef3f7.json  

gcloud config set project fyre-400407  

gcloud container clusters get-credentials hypermine-gke --region asia-south1

node src/index.js