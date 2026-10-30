/**
 * Keep-alive.
 *
 * Sur les tiers gratuits (Render, Railway, Fly), le service s'endort apres
 * ~15 minutes d'inactivite. Un agent acheteur qui appelle un service endormi
 * recoit un timeout et ne revient jamais. Ce script empeche la mise en veille.
 *
 * Il n'appelle PAS l'endpoint payant : cela creerait du volume artificiel
 * (des appels que personne n'a payes), ce qui fausserait les metriques et
 * pourrait etre qualifie de self-dealing. Il ne touche que /health.
 */

const URL = process.env.SELF_HEALTH_URL || "http://localhost:4021/health";
const EVERY = Number(process.env.HEARTBEAT_MS || 5 * 60 * 1000);

async function ping() {
  const started = Date.now();
  try {
    const res = await fetch(URL, {
      method: "GET",
      signal: AbortSignal.timeout(10000),
    });
    console.log(
      new Date().toISOString(),
      `ping ok status=${res.status} latency=${Date.now() - started}ms`,
    );
  } catch (err) {
    console.error(new Date().toISOString(), "ping failed:", err.message);
  }
}

ping();
setInterval(ping, EVERY);
console.log(`heartbeat every ${EVERY}ms -> ${URL}`);
