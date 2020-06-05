ARG NODE_JS_VERSION=8

FROM node:${NODE_JS_VERSION}-alpine

WORKDIR /opt/dynamodb-table-sync

COPY ./package*.json ./

RUN npm install

COPY . .

ENTRYPOINT [ "node" ]

CMD [ "src/cli.js" ]
