
import k8s from '@kubernetes/client-node'
import { spawn } from 'child_process'
// Path to the service account key file

const keyFilePath = process.env.GOOGLE_APPLICATION_CREDENTIALS


export function execGcloudCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const gcloudProcess = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true, // Use shell to support command strings
    });

    let stdout = '';
    let stderr = '';

    gcloudProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    gcloudProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    gcloudProcess.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(stderr);
      }
    });

    gcloudProcess.on('error', (err) => {
      reject(err);
    });
  });
}
export async function getKubeconfig() {


  // Obtain access token

  // Use access token to interact with Kubernetes
  const kubeconfig = new k8s.KubeConfig();
  await kubeconfig.loadFromDefault()

  return kubeconfig;
}


