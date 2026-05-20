import { configDotenv } from 'dotenv';
import { getKubeconfig } from './auth.js';
configDotenv()


import amqp from 'amqplib'
import k8s from '@kubernetes/client-node';

const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const shouldLog = (level) => LOG_LEVELS[level] <= (LOG_LEVELS[LOG_LEVEL] ?? 2);
const log = (level, ...args) => {
  if (!shouldLog(level)) return;
  const ts = new Date().toISOString();
  const out = level === 'error' ? console.error : console.log;
  out(`[${ts}] [${level.toUpperCase()}]`, ...args);
};

const getPodErrorReason = (pod) => {
  const waitingReasons = new Set([
    'ErrImagePull',
    'ImagePullBackOff',
    'CrashLoopBackOff',
    'CreateContainerConfigError',
    'InvalidImageName'
  ]);
  const containerStatuses = pod?.status?.containerStatuses || [];
  for (const cs of containerStatuses) {
    const reason = cs?.state?.waiting?.reason;
    if (reason && waitingReasons.has(reason)) {
      return reason;
    }
  }

  const conditions = pod?.status?.conditions || [];
  for (const c of conditions) {
    if (c?.reason === 'Unschedulable') {
      return 'Unschedulable';
    }
  }

  return null;
};










const kc = new k8s.KubeConfig()

kc.loadFromDefault()



const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const set = new Map();





const checkIfPodExists = async (podName) => {
  try {
    const namespace = 'hypermine-development'
    const res = await k8sApi.readNamespacedPod(podName, namespace);
    // console.log(res?.body?.status?.phase);
    if (res?.body?.status?.phase) {

      return { found: true, status: res?.body?.status?.phase }
    }

  } catch (error) {
    // console.log(error.body);
    if (error?.body?.reason == 'NotFound') {
      //  Provison new POD
      return { found: false }
    }
  }

  return { found: false, status: 'Unknown' }

}
const deploy = async (name,
  env
) => {
  try {
    globalThis[name] = 0

    const deployment = {
      metadata: {
        name: name
      },

      spec: {
        restartPolicy: 'Never', // Ensure the pod does not restart on failure

        containers: [
          {
            name: name,
            image: 'ghcr.io/hypersign-protocol/txn-processor-dynamic:' + process.env.TXN_PROCESSOR_DYNAMIC_TAG,
            env: Object.entries(env).map(([key, value]) => ({
              name: key,
              value: value
            })),
            volumeMounts: [
              {
                name: 'mongo',
                mountPath: '/data'

              }
            ]

          }],
        volumes: [
          {
            name: 'mongo',
            secret: {
              secretName: 'mongo'
            }
          }
        ]
      }
    }




    const data = await k8sApi.createNamespacedPod("hypermine-development", deployment)
    const interval = setInterval(async () => {
      const namespace = 'hypermine-development'
      const res = await k8sApi.readNamespacedPod(name, namespace);
      const pod = res.body
      log('debug', `Pod ${pod.metadata.name} in ${pod.metadata.namespace} is ${pod.status.phase}`);

      const errorReason = getPodErrorReason(pod);
      if (errorReason) {
        clearInterval(interval)
        set.delete(pod.metadata.name)
        await k8sApi.deleteNamespacedPod(name, "hypermine-development")
        delete globalThis[name]

        log('warn', `Pod ${name} deleted due to error: ${errorReason}`);
        return;
      }

      if (pod.status.phase === 'Pending') {
        log('debug', `Pod ${name} pending count: ${globalThis[name]}`);
        if (globalThis[name] > 10) {
          clearInterval(interval)
          set.delete(pod.metadata.name)
          await k8sApi.deleteNamespacedPod(name, "hypermine-development")
          delete globalThis[name]

          log('warn', `Pod ${name} deleted after pending timeout`);

        }
        globalThis[name]++

      }
      if (pod.status.phase === 'Succeeded' || pod.status.phase === 'Failed') {


        const data = await k8sApi.deleteNamespacedPod(name, "hypermine-development")
        clearInterval(interval)

        set.delete(name)
        delete globalThis[name]
        log('info', `Pod ${name} completed with status ${pod.status.phase} and was deleted`);
      }

    }, 5000)
    set.set(name, interval)


    // const data = await k8sApi.deleteNamespacedPod("txn-processor-wallet", "hypermine-development")
    // console.log(data.body.status.phase);
  } catch (err) {
    log('error', err);
    throw err; // let the consumer catch block handle it
  }
};



const queueName = process.env.GLOBAL_TXN_CONTROLLER_QUEUE || 'GLOBAL_TXN_CONTROLLER_QUEUE';
const dlqName = process.env.GLOBAL_TXN_CONTROLLER_DLQ || 'GLOBAL_TXN_CONTROLLER_DLQ';
const MAX_DLQ_RETRIES = parseInt(process.env.MAX_DLQ_RETRIES || '5');
const DLQ_DRAIN_INTERVAL_MS = parseInt(process.env.DLQ_DRAIN_INTERVAL_MS || '300000'); // 5 min

// Send message to DLQ, preserving original content. Tracks retry count in headers.
const sendToDLQ = (channel, message, errorReason) => {
  const retryCount = message.properties.headers?.['x-dlq-retry-count'] || 0;
  if (retryCount >= MAX_DLQ_RETRIES) {
    log('error', `Message permanently discarded after ${MAX_DLQ_RETRIES} DLQ retries. Reason: ${errorReason}`);
    return;
  }
  channel.sendToQueue(dlqName, message.content, {
    persistent: true,
    headers: {
      ...message.properties.headers,
      'x-dlq-retry-count': retryCount + 1,
      'x-dlq-reason': String(errorReason).slice(0, 500),
      'x-dlq-entered-at': new Date().toISOString()
    }
  });
  log('warn', `Message sent to DLQ (attempt ${retryCount + 1}/${MAX_DLQ_RETRIES}): ${errorReason}`);
};

// Drain DLQ by republishing messages back to the main queue in their original format.
const drainDLQ = async (channel) => {
  let count = 0;
  try {
    while (true) {
      const msg = await channel.get(dlqName, { noAck: false });
      if (!msg) break;
      const retryCount = msg.properties.headers?.['x-dlq-retry-count'] || 0;
      if (retryCount >= MAX_DLQ_RETRIES) {
        log('error', `Permanently discarding DLQ message after ${retryCount} retries`);
        channel.ack(msg);
        continue;
      }
      // Republish original content back to main queue — consumer will process it normally
      channel.sendToQueue(queueName, msg.content, {
        persistent: false,
        headers: msg.properties.headers
      });
      channel.ack(msg);
      count++;
    }
  } catch (err) {
    log('error', `DLQ drain error: ${err.message}`);
  }
  if (count > 0) log('info', `DLQ drained: ${count} message(s) republished to main queue`);
};

(async () => {
  try {
    log('info', 'Start Service');

    const namespace = 'hypermine-development'

    const connection = await amqp.connect(process.env.AMQ_URL, {
      heartbeat: 30
    })
    const channel = await connection.createChannel();
    await channel.assertQueue(queueName, { durable: false });
    await channel.assertQueue(dlqName, { durable: true });
    const drainInterval = setInterval(() => drainDLQ(channel), DLQ_DRAIN_INTERVAL_MS);
    log('info', `DLQ drain scheduled every ${DLQ_DRAIN_INTERVAL_MS / 1000}s`);
    await channel.consume(queueName, async (message) => {
      let queueMsg;
      log('debug', 'Trying to consume')

      if (!message) {
        return
      }

      try {

        const msg = message.content.toString()
        const parsedMessage = JSON.parse(msg)
        queueMsg = {
          ...parsedMessage,
          DB_URL: process.env.DB_URL + '/' + process.env.PREFIX + parsedMessage.tenent + process.env.DB_CONFIG,
        }

        const podName = parsedMessage.podName + '-' + parsedMessage.granteeWalletAddress

        // parse and create a pod to kubernetes

        const { found, status } = await checkIfPodExists(podName)
        if (found && (status === 'Succeeded' || status === 'Failed')) {
          await k8sApi.deleteNamespacedPod(podName, "hypermine-development")
        }
        if (found && status !== "Succeeded" && status !== "Failed") {
          log('info', `Pod ${podName} already exists with status ${status}`);
          channel.ack(message)
          return
        } else {

          await deploy(podName, queueMsg)
          channel.ack(message)

          log('info', `Pod ${podName} deployment requested`);
        }

      } catch (error) {
        log('error', error.message);
        sendToDLQ(channel, message, error.message);
        channel.ack(message);
      }

    })

    const shutdown = async (signal) => {
      log('info', `${signal} received, shutting down gracefully...`);
      clearInterval(drainInterval);
      try { await channel.close(); } catch (_) {}
      try { await connection.close(); } catch (_) {}
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM')); // k8s sends this
    process.on('SIGINT', () => shutdown('SIGINT'));    // local dev Ctrl+C
  } catch (error) {
    log('error', error.message)
  }
})()










