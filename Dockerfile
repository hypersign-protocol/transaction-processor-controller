FROM  node:18
SHELL ["/bin/bash", "-c"]


RUN apt-get update

RUN curl https://sdk.cloud.google.com | bash


ENV PATH="/root/google-cloud-sdk/bin:${PATH}"
RUN  gcloud components install gke-gcloud-auth-plugin


WORKDIR /app



COPY package.json .

RUN npm i


COPY . .


CMD  ["/bin/bash","script.sh"]