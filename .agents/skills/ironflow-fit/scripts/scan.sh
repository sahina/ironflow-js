#!/usr/bin/env bash
# ironflow-fit scanner.
#
# Detects project roots, then sweeps for the signals that indicate event-driven
# or durable-execution pain. Emits TSV so every claim in the report can cite a
# real file:line. This script owns the regexes; the detect-*.md files own the
# interpretation, keyed by the same signal IDs.
#
# Usage: scan.sh [directory]
set -uo pipefail

ROOT="${1:-.}"
MAX="${IRONFLOW_FIT_MAX_HITS:-6}"
MAX_PROJECTS="${IRONFLOW_FIT_MAX_PROJECTS:-25}"

[ -d "$ROOT" ] || { echo "scan.sh: not a directory: $ROOT" >&2; exit 1; }

EXCL=(--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=target
      --exclude-dir=obj --exclude-dir=bin --exclude-dir=dist --exclude-dir=build
      --exclude-dir=.venv --exclude-dir=venv --exclude-dir=__pycache__
      --exclude-dir=vendor --exclude-dir=.next --exclude-dir=.gradle
      --exclude-dir=.idea --exclude-dir=.mvn --exclude-dir=coverage)

# sig <stack> <signal-id> <include-glob> <extended-regex>
sig() {
  local stack="$1" id="$2" inc="$3" pat="$4"
  local hits count
  hits=$(grep -rnE "${EXCL[@]}" --include="$inc" -- "$pat" "$ROOT" 2>/dev/null)
  [ -z "$hits" ] && return 0
  count=$(printf '%s\n' "$hits" | wc -l | tr -d ' ')
  printf '%s\n' "$hits" | head -n "$MAX" | while IFS= read -r line; do
    local loc text
    loc="${line%%:*}"; line="${line#*:}"
    loc="$loc:${line%%:*}"; text="${line#*:}"
    text=$(printf '%s' "$text" | sed 's/^[[:space:]]*//' | cut -c1-120)
    printf 'signal\t%s\t%s\t%s\t%s\t%s\n' "$stack" "$id" "$count" "$loc" "$text"
  done
}

echo "# ironflow-fit scan of $ROOT"
echo "# columns: signal <TAB> stack <TAB> signal-id <TAB> total-hits <TAB> file:line <TAB> match"
echo

echo "## projects"
found=0
while IFS= read -r marker; do
  [ -z "$marker" ] && continue
  found=$((found+1))
  [ "$found" -gt "$MAX_PROJECTS" ] && continue
  dir=$(dirname "$marker"); base=$(basename "$marker")
  case "$base" in
    pom.xml|build.gradle|build.gradle.kts) stack=java ;;
    *.csproj|*.fsproj|*.sln)               stack=dotnet ;;
    pyproject.toml|requirements.txt|manage.py) stack=python ;;
    Cargo.toml)                            stack=rust ;;
    package.json)                          stack=node ;;
    go.mod)                                stack=go ;;
    *)                                     stack=unknown ;;
  esac
  printf 'project\t%s\t%s\t%s\n' "$dir" "$stack" "$base"
done < <(find "$ROOT" \
    \( -name node_modules -o -name .git -o -name target -o -name obj -o -name bin \
       -o -name dist -o -name build -o -name .venv -o -name venv -o -name vendor \
       -o -name __pycache__ -o -name .next -o -name .gradle \) -prune -o \
    -type f \( -name pom.xml -o -name 'build.gradle*' -o -name '*.csproj' -o -name '*.sln' \
       -o -name pyproject.toml -o -name requirements.txt -o -name manage.py \
       -o -name Cargo.toml -o -name package.json -o -name go.mod \) -print 2>/dev/null | sort)
[ "$found" -gt "$MAX_PROJECTS" ] && printf 'skipped\tproject-cap\t%s projects found, first %s reported\n' "$found" "$MAX_PROJECTS"
echo

echo "## signals"

# ---- Java / Spring -------------------------------------------------------
sig java java.scheduled          '*.java' '@Scheduled|org\.quartz|@EnableBatchProcessing|@EnableScheduling'
sig java java.fire-and-forget    '*.java' '@Async|CompletableFuture\.(supplyAsync|runAsync)|TaskExecutor'
sig java java.remote-in-txn      '*.java' '(RestTemplate|WebClient|FeignClient|HttpClient)'
sig java java.transactional      '*.java' '@Transactional'
sig java java.broker-consumer    '*.java' '@RabbitListener|@KafkaListener|@JmsListener|@StreamListener|EnableBinding'
sig java java.retry              '*.java' '@Retryable|RetryTemplate|io\.github\.resilience4j|@CircuitBreaker'
sig java java.status-column      '*.java' '(private|public)[[:space:]]+[A-Za-z]*Status[[:space:]]+status|@Enumerated'
sig java java.history-table      '*.sql' '(CREATE TABLE|create table)[[:space:]]+[a-z_]*(_history|_audit|_log|_events|outbox)'
sig java java.long-timeout       '*.yml' 'request-timeout|read-timeout|connection-timeout'
sig java java.long-timeout       '*.yaml' 'request-timeout|read-timeout|connection-timeout'
sig java java.long-timeout       '*.properties' 'request-timeout|read-timeout|connection-timeout'
sig java java.webhook            '*.java' '@PostMapping.*(webhook|hook|callback)|X-.*-Signature'
sig java java.feign-edge         '*.java' '@FeignClient\('

# ---- C# / .NET -----------------------------------------------------------
sig dotnet dotnet.scheduled      '*.cs' 'BackgroundJob\.(Enqueue|Schedule)|RecurringJob|Quartz|IHostedService|BackgroundService|TimerTrigger'
sig dotnet dotnet.fire-and-forget '*.cs' 'Task\.Run\(|_ = [A-Za-z]+Async\('
sig dotnet dotnet.broker-consumer '*.cs' 'MassTransit|NServiceBus|Rebus|ServiceBusClient|IAmazonSQS|IConsumer<'
sig dotnet dotnet.retry          '*.cs' 'Policy\.Handle|WaitAndRetry|CircuitBreakerAsync|Polly'
sig dotnet dotnet.remote-in-txn  '*.cs' 'SaveChangesAsync|SaveChanges\(\)'
sig dotnet dotnet.httpclient     '*.cs' 'HttpClient|IHttpClientFactory'
sig dotnet dotnet.status-column  '*.cs' 'public[[:space:]]+[A-Za-z]*Status[[:space:]]+Status|enum[[:space:]]+[A-Za-z]*Status'
sig dotnet dotnet.history-table  '*.cs' 'DbSet<[A-Za-z]*(History|Audit|Event|Outbox)'
sig dotnet dotnet.service-edge   '*.json' '"(BaseUrl|BaseAddress|ServiceUrl|ApiUrl)"'

# ---- Python --------------------------------------------------------------
sig python python.scheduled      '*.py' '@shared_task|@app\.task|celery|APScheduler|BackgroundScheduler|django_q|dramatiq|from rq'
sig python python.fire-and-forget '*.py' 'BackgroundTasks|asyncio\.create_task|\.delay\(|\.apply_async\('
sig python python.signals        '*.py' '@receiver\((post_save|pre_save)|(post_save|pre_save)\.connect'
sig python python.remote-in-txn  '*.py' 'transaction\.atomic'
sig python python.http-client    '*.py' 'requests\.(post|put|get)|httpx\.(post|put|get)|aiohttp'
sig python python.retry          '*.py' 'from tenacity|@retry|backoff\.on_exception|max_retries'
sig python python.broker-consumer '*.py' 'kombu|pika|boto3.*sqs|KafkaConsumer|aio_pika'
sig python python.status-column  '*.py' 'status[[:space:]]*=[[:space:]]*models\.CharField|STATUS_CHOICES'
sig python python.history-table  '*.py' 'simple_history|HistoricalRecords|class [A-Za-z]*(History|Audit|Event)\('

# ---- Rust ----------------------------------------------------------------
sig rust rust.scheduled          '*.rs' 'tokio_cron_scheduler|JobScheduler|cron::'
sig rust rust.fire-and-forget    '*.rs' 'tokio::spawn'
sig rust rust.broker-consumer    '*.rs' 'lapin|rdkafka|aws_sdk_sqs|async_nats'
sig rust rust.retry              '*.rs' 'backoff::|tokio_retry|retry\('
sig rust rust.remote-in-txn      '*.rs' 'begin\(\)\.await|\.commit\(\)\.await'
sig rust rust.http-client        '*.rs' 'reqwest::'

# ---- Node / TypeScript ---------------------------------------------------
sig node node.scheduled          '*.ts' 'bullmq|pg-boss|node-cron|agenda|bree|@nestjs/schedule|@Cron'
sig node node.scheduled          '*.js' 'bullmq|pg-boss|node-cron|agenda|bree'
sig node node.fire-and-forget    '*.ts' 'void [a-zA-Z]+\(|setImmediate\(|\.catch\(\(\) => \{\}\)'
sig node node.fire-and-forget    '*.js' 'setImmediate\(|\.catch\(\(\) => \{\}\)'
sig node node.broker-consumer    '*.ts' 'amqplib|kafkajs|@aws-sdk/client-sqs|nats\.connect'
sig node node.broker-consumer    '*.js' 'amqplib|kafkajs|@aws-sdk/client-sqs|nats\.connect'
sig node node.retry              '*.ts' 'p-retry|async-retry|exponentialBackoff|maxRetries'
sig node node.retry              '*.js' 'p-retry|async-retry|exponentialBackoff|maxRetries'
sig node node.status-column      '*.ts' "status:[[:space:]]*['\"](pending|processing|failed|completed)"
sig node node.status-column      '*.js' "status:[[:space:]]*['\"](pending|processing|failed|completed)"
sig node node.read-model         '*.sql' 'JOIN.*JOIN.*JOIN'

# ---- Go ------------------------------------------------------------------
sig go go.scheduled              '*.go' 'time\.NewTicker|robfig/cron|gocron'
sig go go.fire-and-forget        '*.go' 'go func\(\)'
sig go go.broker-consumer        '*.go' 'watermill|nats-io|segmentio/kafka-go|(Shopify|IBM)/sarama'
sig go go.retry                  '*.go' 'backoff\.|retry\.Do|MaxRetries'
sig go go.remote-in-txn          '*.go' 'db\.Begin\(|tx\.Commit\('
echo

echo "## infra"
for f in $(find "$ROOT" \( -name node_modules -o -name .git -o -name target -o -name vendor \) -prune -o \
     -type f \( -name 'docker-compose*.y*ml' -o -name 'compose.y*ml' \) -print 2>/dev/null | head -5); do
  printf 'infra\tcompose\t%s\n' "$f"
  grep -nE '^[[:space:]]{2}[a-zA-Z0-9_-]+:|depends_on|image:' "$f" 2>/dev/null | head -40 |
    while IFS= read -r l; do printf 'infra-line\t%s:%s\n' "$f" "$l"; done
done
for f in $(find "$ROOT" \( -name node_modules -o -name .git -o -name vendor \) -prune -o \
     -type f \( -name 'application*.y*ml' -o -name 'appsettings*.json' -o -name '.env*' \) -print 2>/dev/null | head -8); do
  printf 'infra\tconfig\t%s\n' "$f"
  # Mask credentials: `scheme://user:pass@host` -> `scheme://***@host`. The report is
  # meant to be forwarded; a .env line must never carry a password into it.
  grep -nE 'https?://|_URL|_HOST|BaseUrl|base-url' "$f" 2>/dev/null | head -15 |
    sed -E 's#(://)[^/@[:space:]]+@#\1***@#g' |
    while IFS= read -r l; do printf 'infra-line\t%s:%s\n' "$f" "$l"; done
done
grep -rlnE "${EXCL[@]}" --include='*.y*ml' 'kind:[[:space:]]*(Deployment|Service|CronJob)' "$ROOT" 2>/dev/null | head -5 |
  while IFS= read -r f; do printf 'infra\tk8s\t%s\n' "$f"; done
echo

echo "## readiness-probes"
sig probe probe.tracing      '*'    'opentelemetry|OpenTelemetry|jaeger|zipkin|DiagnosticSource|traceparent'
sig probe probe.idempotency  '*'    'idempotenc|ON CONFLICT|upsert|INSERT .* ON DUPLICATE|MERGE INTO'
sig probe probe.dlq          '*'    'dead[-_ ]?letter|dlq|DeadLetter'
sig probe probe.async-tests  '*'    'await.*expect|Awaitility|pytest\.mark\.asyncio|TestAsync|eventually'
sig probe probe.contracts    '*'    'openapi|swagger|\.proto|avsc|schema_version|schemaVersion'
echo

echo "## scale"
nfiles=$(find "$ROOT" \( -name node_modules -o -name .git -o -name target -o -name vendor -o -name .venv \) -prune -o -type f -print 2>/dev/null | wc -l | tr -d ' ')
printf 'scale\tfiles\t%s\n' "$nfiles"
printf 'scale\tprojects\t%s\n' "$found"
