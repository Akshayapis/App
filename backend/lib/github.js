'use strict';
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { bad } = require('./firebase');

function gh(settings) {
  if (!settings.ghOwner || !settings.ghRepo || !settings.ghToken) {
    bad(500, 'GitHub build service is not configured yet. Set it up in the Admin Panel first.');
  }
  const base = `https://api.github.com/repos/${settings.ghOwner}/${settings.ghRepo}`;
  const headers = {
    Authorization: `Bearer ${settings.ghToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  return { base, headers };
}

/** Kicks off the platform's own Android build workflow with this request's inputs.
 *  GitHub workflow_dispatch does not return a run id, so the workflow must set
 *  `run-name: build-${{ inputs.request_id }}` so we can find it afterwards. */
async function dispatchBuild(settings, requestId, { websiteUrl, appName, packageName, iconUrl }) {
  const { base, headers } = gh(settings);
  const r = await fetch(`${base}/actions/workflows/${encodeURIComponent(settings.ghWorkflow)}/dispatches`, {
    method: 'POST', headers,
    body: JSON.stringify({ ref: settings.ghRef, inputs: { request_id: requestId, website_url: websiteUrl, app_name: appName, package_name: packageName, icon_url: iconUrl } }),
    signal: AbortSignal.timeout(15000),
  });
  if (r.status !== 204) bad(502, `GitHub refused to start the build (HTTP ${r.status}). Check the Admin Panel's GitHub build settings.`);
}

/** workflow_dispatch has no return value, so we poll recent runs and match by run-name. */
async function findRunByRequestId(settings, requestId, attempts = 10, delayMs = 3000) {
  const { base, headers } = gh(settings);
  for (let i = 0; i < attempts; i++) {
    const r = await fetch(`${base}/actions/workflows/${encodeURIComponent(settings.ghWorkflow)}/runs?per_page=15`, { headers, signal: AbortSignal.timeout(15000) });
    if (r.ok) {
      const data = await r.json();
      const run = (data.workflow_runs || []).find((x) => (x.name || x.display_title || '').includes(requestId));
      if (run) return run;
    }
    await new Promise((res) => setTimeout(res, delayMs));
  }
  return null;
}

async function pollRunUntilDone(settings, runId, timeoutMs = 20 * 60 * 1000, pollMs = 8000) {
  const { base, headers } = gh(settings);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`${base}/actions/runs/${runId}`, { headers, signal: AbortSignal.timeout(15000) });
    if (!r.ok) bad(502, `Could not check build status (HTTP ${r.status})`);
    const run = await r.json();
    if (run.status === 'completed') return run;
    await new Promise((res) => setTimeout(res, pollMs));
  }
  bad(504, 'Build is taking too long, check it directly on GitHub Actions');
}

/** Downloads the run's artifact zip, extracts the first .apk inside it, saves it to destDir. */
async function downloadApk(settings, runId, destDir, destName) {
  const { base, headers } = gh(settings);
  const lr = await fetch(`${base}/actions/runs/${runId}/artifacts`, { headers, signal: AbortSignal.timeout(15000) });
  if (!lr.ok) bad(502, 'Could not list build artifacts');
  const list = await lr.json();
  const artifact = (list.artifacts || [])[0];
  if (!artifact) bad(404, 'Build finished but produced no downloadable artifact');
  const zr = await fetch(`${base}/actions/artifacts/${artifact.id}/zip`, { headers, redirect: 'follow', signal: AbortSignal.timeout(60000) });
  if (!zr.ok) bad(502, 'Could not download the build artifact');
  const buf = Buffer.from(await zr.arrayBuffer());
  const zip = new AdmZip(buf);
  const apkEntry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.apk'));
  if (!apkEntry) bad(404, 'Build artifact did not contain an APK file');
  fs.mkdirSync(destDir, { recursive: true });
  const outPath = path.join(destDir, destName);
  fs.writeFileSync(outPath, apkEntry.getData());
  return outPath;
}

module.exports = { dispatchBuild, findRunByRequestId, pollRunUntilDone, downloadApk };
