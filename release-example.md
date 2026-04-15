# Update your Cars Node

## Set variables

```
alias k='microk8s kubectl'
NS=cars-operator-system
DEPLOY=cars
CONTAINER=cars
IMG=cars-node
```

## Create a unique tag

```
VERSION='v1.2.x'
TAG="${VERSION}-server2-$(date +%F-%H%M%S)"
```


PULL_REF="registry.${NS}.svc.cluster.local:5000/${IMG}:${TAG}"

## Pre-deployment safety checks

```
k cluster-info

# Current running state
k -n "$NS" get deploy "$DEPLOY" -o wide
k -n "$NS" get pods -l app=cars -o wide
k -n "$NS" get deploy "$DEPLOY" -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
k -n "$NS" get deploy "$DEPLOY" -o jsonpath='{.spec.template.spec.containers[0].imagePullPolicy}{"\n"}'

# Registry is healthy
k -n "$NS" get deploy registry -o wide
k -n "$NS" get pods -l app=registry -o wide
k -n "$NS" get svc registry -o wide
k -n "$NS" get endpoints registry -o wide

# Backup deploy yaml
k -n "$NS" get deploy "$DEPLOY" -o yaml > "${DEPLOY}.backup.$(date +%F-%H%M%S).yaml"
```


## Start port-forward to registry

```
# Kill any old port-forward listening on 5000 (optional)
pkill -f "kubectl.*port-forward.*svc/registry 5000:5000" 2>/dev/null || true

# Port-forward in the background
k -n "$NS" port-forward svc/registry 5000:5000 >/tmp/registry-pf.log 2>&1 &
PF=$!

# Confirm the tunnel is up
ss -ltnp | grep ':5000 ' || (echo "port-forward not listening" && tail -n 50 /tmp/registry-pf.log)
curl -fsSL http://127.0.0.1:5000/v2/ && echo   # expect: {}
```

## Ensure Docker can push to port

```
docker info 2>/dev/null | sed -n '/Insecure Registries:/,/Registry Mirrors:/p'

sudo tee /etc/docker/daemon.json >/dev/null <<'JSON'
{"insecure-registries":["127.0.0.1:5000","localhost:5000"]}
JSON
sudo systemctl restart docker
```

## Build and push

```
PUSH_REF="127.0.0.1:5000/${IMG}:${TAG}"

echo "PUSH_REF=$PUSH_REF"
echo "PULL_REF=$PULL_REF"

docker build -t "$PUSH_REF" .
docker push "$PUSH_REF"
```

## Confirm the tag is in the registry:

```
curl -fsSL "http://127.0.0.1:5000/v2/${IMG}/tags/list" | jq .
```

## Dry-run the deployment change (test)

```
k -n "$NS" set image deploy/"$DEPLOY" "$CONTAINER"="$PULL_REF" \
  --dry-run=server -o yaml | sed -n '1,140p'
```

## Apply the deployment change

```
k -n "$NS" set image deploy/"$DEPLOY" "$CONTAINER"="$PULL_REF"
```

## Watch rollout and validate health

After rollout, validate both the CARS control plane and the deployed project health:

```bash
curl -fsS https://cars.example.com/health | jq
curl -fsS https://cars.example.com/health/ready | jq
```

For a specific project, use the authenticated `POST /api/v1/project/<projectId>/health` endpoint from an existing CARS client session to verify sticky routing, replica readiness, and backend health.

```
k -n "$NS" rollout status deploy/"$DEPLOY" --timeout=180s
k -n "$NS" get pods -l app=cars -o wide

k -n "$NS" get events --sort-by=.lastTimestamp | tail -n 40

k -n "$NS" logs -l app=cars --tail=200
```

## Confirm it's actually running your new image

```
NEWPOD=$(k -n "$NS" get pods -l app=cars -o jsonpath='{.items[0].metadata.name}')
k -n "$NS" get pod "$NEWPOD" -o jsonpath='{.spec.containers[0].image}{"\n"}'
k -n "$NS" get pod "$NEWPOD" -o jsonpath='{.status.containerStatuses[0].imageID}{"\n"}'
```

## Cleanup port-forwarding

```
kill "$PF" 2>/dev/null || true
```

---

# If anything goes wrong:
## Fast rollback

```
k -n "$NS" rollout undo deploy/"$DEPLOY"
k -n "$NS" rollout status deploy/"$DEPLOY" --timeout=180s
k -n "$NS" get pods -l app=cars -o wide
k -n "$NS" get events --sort-by=.lastTimestamp | tail -n 40
```
