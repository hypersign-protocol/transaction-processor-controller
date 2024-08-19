import { configDotenv } from 'dotenv';
import { getKubeconfig } from './auth.js';
configDotenv()


import amqp from 'amqplib'
import k8s from '@kubernetes/client-node';










const kc = new k8s.KubeConfig()

kc.loadFromDefault()



const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const set = new Map();





const checkIfPodExists = async (podName) => {
  try {
    const namespace = 'hypermine-development'
    const res = await k8sApi.readNamespacedPod(podName, namespace);
    console.log(res?.body?.status?.phase);
    if (res?.body?.status?.phase) {

      return { found: true, status: res?.body?.status?.phase }
    }

  } catch (error) {
    console.log(error.body);
    if (error.body.reason == 'NotFound') {
      //  Provison new POD
      return { found: false }
    }
  }

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
            }))

          }]
      }
    }




    const data = await k8sApi.createNamespacedPod("hypermine-development", deployment)
    const interval = setInterval(async () => {
      const namespace = 'hypermine-development'
      const res = await k8sApi.readNamespacedPod(name, namespace);
      const pod = res.body
      console.log(`Name: ${pod.metadata.name}`);
      console.log(`Namespace: ${pod.metadata.namespace}`);
      console.log(`  Status: ${pod.status.phase}`);
      console.log(`  Containers: ${pod.spec.containers.map(container => container.name).join(', ')}`);
      console.log(`  Conditions: ${pod.status.conditions.map(c => `${c.type}: ${c.status}`).join(', ')}`);
      console.log('---');
      console.log(pod.status.phase);
      if (pod.status.phase === 'Pending') {
        console.log(globalThis[name]);
        console.log(name);
        if (globalThis[name] > 10) {
          set.delete(pod.metadata.name)
          await k8sApi.deleteNamespacedPod(name, "hypermine-development")

        }
        globalThis[name]++

      }
      if (pod.status.phase === 'Succeeded' || pod.status.phase === 'Failed') {


        const data = await k8sApi.deleteNamespacedPod(name, "hypermine-development")
        const intervals = set.get(name)
        clearInterval(interval)

        set.delete(name)
      }

    }, 5000)
    set.set(name, interval)


    // const data = await k8sApi.deleteNamespacedPod("txn-processor-wallet", "hypermine-development")
    // console.log(data.body.status.phase);
  } catch (err) {
    console.error(err);
  }
};



const queueName = process.env.GLOBAL_TXN_CONTROLLER_QUEUE || 'GLOBAL_TXN_CONTROLLER_QUEUE';

(async () => {
  try {
    console.log("Start Service");

    const namespace = 'hypermine-development'

    const connection = await amqp.connect(process.env.AMQ_URL)
    const channel = await connection.createChannel();
    await channel.assertQueue(queueName, {
      durable: false,

    })
    await channel.consume(queueName, async (message) => {
      let queueMsg;
      console.log("Trying to consume")

      try {

        console.log(message);
        const msg = message.content.toString()
        const parsedMessage = JSON.parse(msg)
        queueMsg = parsedMessage

        const podName = parsedMessage.podName + '-' + parsedMessage.granteeWalletAddress
        console.log(podName);

        // parse and create a pod to kubernetes

        const { found, status } = await checkIfPodExists(podName)
        console.log({
          found, status
        });
        if (found && status !== "Succeeded") {

          return
        } else {

          await deploy(podName, queueMsg)
          channel.ack(message)

        }

      } catch (error) {
        console.log(error.message);

      }

    })

  } catch (error) {
    console.log(error.message)
  }
})()







