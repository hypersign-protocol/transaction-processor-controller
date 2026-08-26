# Transaction processor controller

This service listens for wallet bootstrap requests and creates one
`txn-processor-dynamic` Kubernetes pod per grantee wallet.

It does not receive individual blockchain messages. Those messages are already
waiting in the wallet-specific queue consumed by the dynamic pod.

## Responsibilities

1. Consume a bootstrap request from `GLOBAL_TXN_CONTROLLER_QUEUE`.
2. Build the tenant-specific MongoDB URL.
3. Check whether the wallet's processor pod already exists.
4. Create the pod when needed and pass the bootstrap fields as environment
   variables.
5. Monitor the pod and delete it after completion, failure, or a prolonged
   pending state.
6. Move bootstrap requests that cannot be processed to the controller DLQ.

The Kubernetes namespace is currently `hypermine-development`. Dynamic pod
images use:

```text
ghcr.io/hypersign-protocol/txn-processor-dynamic:<TXN_PROCESSOR_DYNAMIC_TAG>
```

## RabbitMQ queues

| Queue                    | Default                       | Durability  | Producer/consumer                   |
| ------------------------ | ----------------------------- | ----------- | ----------------------------------- |
| Controller queue         | `GLOBAL_TXN_CONTROLLER_QUEUE` | Non-durable | Entity API -> controller            |
| Controller DLQ           | `GLOBAL_TXN_CONTROLLER_DLQ`   | Durable     | Controller failures and retry drain |
| Wallet transaction queue | `TXN_QUEUE_<wallet-address>`  | Non-durable | Entity API -> dynamic processor     |

The controller DLQ preserves the original bootstrap message and adds:

- `x-dlq-retry-count`
- `x-dlq-reason`
- `x-dlq-entered-at`

The DLQ is periodically drained back into the controller queue. Messages are
discarded after `MAX_DLQ_RETRIES`.

## Bootstrap message

The entity API publishes a JSON object to `GLOBAL_TXN_CONTROLLER_QUEUE`.
The controller copies every field into the dynamic pod environment and adds the
calculated `DB_URL`.

```json
{
  "RMQ_URL": "amqp://rabbitmq:5672",
  "QUEUE_NAME": "TXN_QUEUE_hid1abc...",
  "NODE_RPC_URL": "https://rpc.example",
  "GRANTEE_MNEMONIC": "<secret>",
  "GRANTER_ADDRESS": "hid1granter...",
  "DID_REGISTER_FIXED_FEE": "4000",
  "DID_UPDATE_FIXED_FEE": "1000",
  "DID_DEACTIVATE_FIXED_FEE": "1000",
  "CRED_REGISTER_FIXED_FEE": "2000",
  "CRED_UPDATE_FIXED_FEE": "2000",
  "SCHEMA_CREATE_FIXED_FEE": "2000",
  "SCHEMA_UPDATE_FIXED_FEE": "2000",
  "ESTIMATE_GAS_PRICE": "155303",
  "podName": "txn-dynamic",
  "granteeWalletAddress": "hid1abc...",
  "tenent": "tenant-subdomain",
  "Tx_Query_API": "https://api.example/cosmos/tx/v1beta1/txs/",
  "SSI_TXN_RESULT_EXCHANGE": "ssi.txn.results"
}
```

`tenent` is intentionally shown with the existing misspelling. The controller
currently reads that exact property when constructing the MongoDB URL. Renaming
it requires a coordinated entity API and controller change.

`Tx_Query_API` is also the spelling currently sent by the entity API. The
dynamic worker reads `TX_QUERY_API`, so a custom value is not applied today and
the worker uses its default endpoint. Correcting the name requires a coordinated
entity API deployment.

The dynamic pod name is:

```text
<podName>-<granteeWalletAddress>
```

If that pod is already running or pending, the controller acknowledges the
bootstrap request without creating another pod.

## Controller environment variables

| Variable                      | Required | Default                       | Purpose                                    |
| ----------------------------- | -------- | ----------------------------- | ------------------------------------------ |
| `AMQ_URL`                     | Yes      | None                          | RabbitMQ connection used by the controller |
| `GLOBAL_TXN_CONTROLLER_QUEUE` | No       | `GLOBAL_TXN_CONTROLLER_QUEUE` | Bootstrap queue name                       |
| `GLOBAL_TXN_CONTROLLER_DLQ`   | No       | `GLOBAL_TXN_CONTROLLER_DLQ`   | Failed-bootstrap queue                     |
| `MAX_DLQ_RETRIES`             | No       | `5`                           | Maximum DLQ processing attempts            |
| `DLQ_DRAIN_INTERVAL_MS`       | No       | `300000`                      | Delay between DLQ drain passes             |
| `TXN_PROCESSOR_DYNAMIC_TAG`   | Yes      | None                          | Dynamic processor container tag            |
| `DB_URL`                      | Yes      | None                          | MongoDB server/base connection string      |
| `PREFIX`                      | Yes      | None                          | Prefix added before the tenant identifier  |
| `DB_CONFIG`                   | Yes      | None                          | MongoDB connection suffix/options          |
| `LOG_LEVEL`                   | No       | `info`                        | `error`, `warn`, `info`, or `debug`        |

The controller uses the cluster's default Kubernetes configuration. Its runtime
identity needs permission to read, create, and delete pods in
`hypermine-development`, and read the `mongo` secret mounted into dynamic
pods.

## Settlement configuration

The controller does not publish settlement events, but it must pass
`SSI_TXN_RESULT_EXCHANGE` from the entity API bootstrap message to the dynamic
pod. The default exchange name across the services is:

```text
ssi.txn.results
```

The Developer Dashboard expects:

| Setting                   | Default                               |
| ------------------------- | ------------------------------------- |
| `RABBIT_MQ_URI`           | Required; no default                  |
| `SSI_TXN_RESULT_EXCHANGE` | `ssi.txn.results`                     |
| `SSI_TXN_RESULT_QUEUE`    | `developer-dashboard.ssi.txn-results` |
| `SSI_TXN_UNKNOWN_QUEUE`   | `developer-dashboard.ssi.txn-unknown` |

The normal result queue binds `ssi.txn.succeeded` and `ssi.txn.failed`.
The unknown queue binds `ssi.txn.unknown` for reconciliation.

All participating applications must use the same RabbitMQ broker and exchange
name.

## Local start

```bash
npm install
npm start
```

The local process also needs working Kubernetes credentials. Starting the
controller without cluster access will connect to RabbitMQ but fail when it
tries to inspect or create a pod.
