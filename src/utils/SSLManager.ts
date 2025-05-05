import dns from 'dns'
import http from 'http'
import { execSync } from 'child_process'

export async function checkAndIssueCertificates() {
    try {
        const ingressList = JSON.parse(execSync('kubectl get ingresses -l created-by=cars --all-namespaces -o json').toString());
        for (const ing of ingressList.items) {
            const hosts: string[] = [];
            const paths = ing.spec.rules || [];
            for (const rule of paths) {
                if (rule.host) {
                    hosts.push(rule.host);
                }
            }

            let needsAnnotation = true;
            for (const host of hosts) {
                const isReachable = await checkHostReachability(host);
                if (!isReachable) {
                    needsAnnotation = false;
                    break;
                }
            }

            const ingressName = ing.metadata.name;
            const ingressNamespace = ing.metadata.namespace;

            const hasAnnotation = ing.metadata.annotations && ing.metadata.annotations["cert-manager.io/cluster-issuer"] === "letsencrypt-production";

            if (needsAnnotation && !hasAnnotation) {
                // Patch ingress to add annotation
                console.log(`Adding cert-manager annotation to ${ingressNamespace}/${ingressName}`);
                execSync(`kubectl annotate ingress ${ingressName} -n ${ingressNamespace} cert-manager.io/cluster-issuer=letsencrypt-production --overwrite`);
            } else if (!needsAnnotation && hasAnnotation) {
                // Remove annotation
                console.log(`Removing cert-manager annotation from ${ingressNamespace}/${ingressName}`);
                execSync(`kubectl annotate ingress ${ingressName} -n ${ingressNamespace} cert-manager.io/cluster-issuer- --overwrite`);
            }
        }
    } catch (err) {
        console.error("SSL Manager script failed:", err);
    }

    async function checkHostReachability(host) {
        return new Promise(resolve => {
            dns.lookup(host, (err) => {
                if (err) {
                    return resolve(false);
                }
                // Try HTTP HEAD
                const req = http.request({ method: 'HEAD', host: host, port: 80, path: '/' }, (res) => {
                    // Any response means it might be reachable
                    res.destroy();
                    resolve(res.statusCode < 500);
                });
                req.on('error', () => resolve(false));
                req.end();
            });
        });
    }
}
