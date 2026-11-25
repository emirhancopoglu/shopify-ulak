/**
 * Arka plan işçisi. İki bağımsız döngü çalıştırır:
 *  1) İş kuyruğu (jobs tablosu): mağaza analizi vb., eşzamanlı
 *  2) Gönderim döngüsü: çalışan kampanyalardan zamanı gelen maili gönderir (hesap başına tek tek)
 * `npm run dev` ile web arayüzüyle birlikte başlar.
 */
import { describeError } from "../src/lib/analyzer/http";
import { recoverInterruptedSends, tickCampaigns } from "../src/lib/campaigns";
import { claimJobs, failJob, finishJob, pruneJobs, requeueRunning, writeHeartbeat, type ClaimedJob } from "../src/lib/jobs";
import { runDiscovery } from "../src/lib/discovery/runner";
import { runStoreAnalysis } from "../src/lib/stores";

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 6);
/** Keşif çalıştırmaları saatlerce sürer (bekleme dahil); analiz yuvalarını işgal etmesinler diye ayrı sınır. */
const DISCOVERY_SLOTS = 8;
const POLL_MS = 1000;
const SEND_TICK_MS = 2000;

const handlers: Record<string, (payload: never) => Promise<void>> = {
  analyze_store: ({ storeId }: { storeId: number }) => runStoreAnalysis(storeId),
  discover: ({ runId }: { runId: number }) => runDiscovery(runId),
};

const active = new Set<Promise<void>>();
const discovering = new Set<Promise<void>>();
let sending: Promise<void> | null = null;
let stopping = false;

function run(job: ClaimedJob, pool: Set<Promise<void>>) {
  const handler = handlers[job.type];
  const p = (async () => {
    try {
      if (!handler) throw new Error(`Bilinmeyen iş türü: ${job.type}`);
      await handler(job.payload as never);
      finishJob(job.id);
    } catch (err) {
      const msg = describeError(err);
      console.error(`iş #${job.id} (${job.type}) hata: ${msg}`);
      failJob(job.id, job.attempts, msg);
    }
  })().finally(() => pool.delete(p));
  pool.add(p);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function jobLoop() {
  let lastPrune = 0;
  while (!stopping) {
    try {
      writeHeartbeat();
      for (const job of claimJobs(CONCURRENCY - active.size, "analyze_store")) run(job, active);
      for (const job of claimJobs(DISCOVERY_SLOTS - discovering.size, "discover")) run(job, discovering);
      if (Date.now() - lastPrune > 3600_000) {
        pruneJobs();
        lastPrune = Date.now();
      }
    } catch (err) {
      console.error("iş döngüsü hatası:", err);
    }
    await sleep(POLL_MS);
  }
}

async function sendLoop() {
  while (!stopping) {
    sending = tickCampaigns().catch((err) => console.error("gönderim döngüsü hatası:", err));
    await sending;
    sending = null;
    await sleep(SEND_TICK_MS);
  }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log(`kapanıyor; ${active.size + discovering.size} iş${sending ? " ve süren gönderim" : ""} bekleniyor…`);
  await Promise.race([Promise.allSettled([...active, ...discovering, sending]), sleep(15_000)]);
  requeueRunning();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const requeued = requeueRunning();
const interrupted = recoverInterruptedSends();
console.log(
  `başladı (eşzamanlı iş: ${CONCURRENCY}` +
    (requeued ? `, yarım kalan ${requeued} iş sıraya alındı` : "") +
    (interrupted ? `, yarıda kalan ${interrupted} gönderim "başarısız" işaretlendi` : "") +
    ")",
);
jobLoop();
sendLoop();
