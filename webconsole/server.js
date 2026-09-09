const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(__dirname, "public");
const terraformPath = process.env.TERRAFORM_EXE || "C:\\Users\\MikeTest\\.scout\\bin\\terraform.exe";
const azPath = process.env.AZ_EXE || "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd";
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";

const vmSizes = [
  "Standard_D2s_v5",
  "Standard_D4s_v5",
  "Standard_D8s_v5",
  "Standard_E2s_v5",
  "Standard_E4s_v5",
  "Standard_E8s_v5"
];

let operation = null;

function json(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(payload);
}

function text(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const isCmd = command.toLowerCase().endsWith(".cmd") || command.toLowerCase().endsWith(".bat");
    const { timeoutMs, ...spawnOptions } = options;
    const child = spawn(isCmd ? process.env.ComSpec || "cmd.exe" : command, isCmd ? ["/d", "/c", command, ...args] : args, {
      cwd: rootDir,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        PATH: `C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin;${process.env.PATH || ""}`
      },
      ...spawnOptions
    });
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs)
      : null;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (timedOut) {
        const error = new Error(`${command} timed out after ${timeoutMs}ms`);
        error.code = "ETIMEDOUT";
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const error = new Error(stderr.trim() || stdout.trim() || `${command} exited ${code}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

async function az(args) {
  return run(azPath, args, { timeoutMs: 45000 });
}

async function azWithTimeout(args, timeoutMs) {
  return run(azPath, args, { timeoutMs });
}

async function terraform(args) {
  return run(terraformPath, args);
}

async function readTfvars() {
  const file = path.join(rootDir, "terraform.tfvars");
  const content = await fs.readFile(file, "utf8");
  return {
    content,
    subscriptionId: matchValue(content, "subscription_id"),
    resourceGroupName: matchValue(content, "resource_group_name") || "rg-avd-starter",
    namePrefix: matchValue(content, "name_prefix") || "avd-starter",
    sessionHostCount: Number(matchValue(content, "session_host_count") || 1),
    maximumSessionsAllowed: Number(matchValue(content, "maximum_sessions_allowed") || 2),
    vmSize: matchValue(content, "vm_size") || "Standard_D2s_v5",
    rdpSourceAddressPrefix: matchValue(content, "rdp_source_address_prefix")
  };
}

function matchValue(content, key) {
  const regex = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "m");
  const match = content.match(regex);
  if (!match) {
    return null;
  }
  const raw = match[1].trim();
  if (raw === "null") {
    return null;
  }
  const quoted = raw.match(/^"([\s\S]*)"$/);
  return quoted ? quoted[1] : raw;
}

async function writeTfvars(updates) {
  const file = path.join(rootDir, "terraform.tfvars");
  let content = await fs.readFile(file, "utf8");
  for (const [key, value] of Object.entries(updates)) {
    const rendered = typeof value === "number" ? String(value) : `"${String(value).replaceAll("\"", "\\\"")}"`;
    const regex = new RegExp(`^(\\s*${key}\\s*=\\s*).*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `$1${rendered}`);
    } else {
      content += `\n${key} = ${rendered}\n`;
    }
  }
  await fs.writeFile(file, content, "utf8");
}

async function terraformOutputs() {
  try {
    const stdout = await terraform(["output", "-json"]);
    return JSON.parse(stdout || "{}");
  } catch (error) {
    return {};
  }
}

function outputValue(outputs, key, fallback) {
  return outputs[key] && Object.hasOwn(outputs[key], "value") ? outputs[key].value : fallback;
}

async function deploymentContext() {
  const tfvars = await readTfvars();
  const outputs = await terraformOutputs();
  const account = JSON.parse(await az(["account", "show", "-o", "json"]));
  const subscriptionId = account.id;
  const resourceGroupName = outputValue(outputs, "resource_group_name", tfvars.resourceGroupName);
  const hostPoolName = outputValue(outputs, "host_pool_name", `${tfvars.namePrefix}-hp`);
  const workspaceName = outputValue(outputs, "workspace_name", `${tfvars.namePrefix}-workspace`);
  return { tfvars, outputs, account, subscriptionId, resourceGroupName, hostPoolName, workspaceName };
}

async function listSessionHosts(context) {
  const url = `https://management.azure.com/subscriptions/${context.subscriptionId}/resourceGroups/${context.resourceGroupName}/providers/Microsoft.DesktopVirtualization/hostPools/${context.hostPoolName}/sessionHosts?api-version=2024-04-03`;
  try {
    const result = JSON.parse(await az(["rest", "--method", "get", "--url", url, "-o", "json"]));
    return (result.value || []).map((hostItem) => ({
      name: hostItem.name,
      shortName: hostItem.name.split("/").pop(),
      status: hostItem.properties.status,
      allowNewSession: hostItem.properties.allowNewSession,
      lastHeartBeat: hostItem.properties.lastHeartBeat,
      resourceId: hostItem.properties.resourceId,
      sessions: hostItem.properties.sessions
    }));
  } catch (error) {
    return [];
  }
}

function sessionHostResourceName(host) {
  return host.name.split("/").pop();
}

function vmNameFromResourceId(resourceId) {
  return resourceId ? resourceId.split("/").pop() : null;
}

function sessionHostUrl(context, hostName) {
  return `${sessionHostBaseUrl(context, hostName)}?api-version=2024-04-03`;
}

function sessionHostBaseUrl(context, hostName) {
  return `https://management.azure.com/subscriptions/${context.subscriptionId}/resourceGroups/${context.resourceGroupName}/providers/Microsoft.DesktopVirtualization/hostPools/${context.hostPoolName}/sessionHosts/${encodeURIComponent(hostName)}`;
}

function userSessionsUrl(context, hostName) {
  return `${sessionHostBaseUrl(context, hostName)}/userSessions?api-version=2024-04-03`;
}

function userSessionActionUrl(context, hostName, sessionId, action) {
  return `${sessionHostBaseUrl(context, hostName)}/userSessions/${encodeURIComponent(sessionId)}/${action}?api-version=2024-04-03`;
}

async function listVms(context) {
  const raw = await az([
    "vm",
    "list",
    "--resource-group",
    context.resourceGroupName,
    "--show-details",
    "--query",
    "[].{name:name,id:id,powerState:powerState,size:hardwareProfile.vmSize,privateIps:privateIps,publicIps:publicIps}",
    "-o",
    "json"
  ]);
  return JSON.parse(raw || "[]");
}

async function metricsForVm(vm) {
  const end = new Date();
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  const metricNames = "Percentage CPU,Available Memory Bytes,Disk Read Bytes,Disk Write Bytes,Network In Total,Network Out Total";
  try {
    const raw = await azWithTimeout([
      "monitor",
      "metrics",
      "list",
      "--resource",
      vm.id,
      "--metric",
      metricNames,
      "--interval",
      "PT5M",
      "--aggregation",
      "Average",
      "--start-time",
      start.toISOString(),
      "--end-time",
      end.toISOString(),
      "-o",
      "json"
    ], 20000);
    const data = JSON.parse(raw || "{}");
    return normalizeMetrics(data.value || []);
  } catch (error) {
    return {
      unavailable: true,
      message: "Azure Monitor metrics are unavailable for this VM or metric namespace."
    };
  }
}

function normalizeMetrics(metrics) {
  const normalized = {};
  for (const metric of metrics) {
    const name = metric.name && (metric.name.localizedValue || metric.name.value);
    normalized[name] = [];
    for (const series of metric.timeseries || []) {
      for (const point of series.data || []) {
        if (point.average !== undefined && point.average !== null) {
          normalized[name].push({ time: point.timeStamp, value: point.average });
        }
      }
    }
  }
  return normalized;
}

async function status() {
  const context = await deploymentContext();
  const [sessionHosts, vms] = await Promise.all([listSessionHosts(context), listVms(context)]);
  const metrics = {};
  await Promise.all(
    vms.map(async (vm) => {
      metrics[vm.name] = await metricsForVm(vm);
    })
  );
  return {
    account: {
      subscription: context.account.name,
      subscriptionId: context.account.id,
      user: context.account.user && context.account.user.name,
      tenantId: context.account.tenantId
    },
    config: {
      sessionHostCount: context.tfvars.sessionHostCount,
      maximumSessionsAllowed: context.tfvars.maximumSessionsAllowed,
      vmSize: context.tfvars.vmSize,
      vmSizes,
      resourceGroupName: context.resourceGroupName,
      hostPoolName: context.hostPoolName,
      workspaceName: context.workspaceName
    },
    sessionHosts,
    vms,
    metrics,
    operation
  };
}

async function deallocateAll() {
  const context = await deploymentContext();
  const vms = await listVms(context);
  for (const vm of vms) {
    await az(["vm", "deallocate", "--ids", vm.id, "--no-wait"]);
  }
  for (const vm of vms) {
    await az(["vm", "wait", "--ids", vm.id, "--custom", "instanceView.statuses[?code=='PowerState/deallocated']"]);
  }
  return { count: vms.length };
}

async function listUserSessions(context, hostName) {
  const raw = await az(["rest", "--method", "get", "--url", userSessionsUrl(context, hostName), "-o", "json"]);
  const result = JSON.parse(raw || "{}");
  return (result.value || []).map((session) => ({
    id: session.name.split("/").pop(),
    name: session.name,
    userPrincipalName: session.properties.userPrincipalName,
    sessionState: session.properties.sessionState,
    activeDirectoryUserName: session.properties.activeDirectoryUserName
  }));
}

async function setAllowNewSession(context, hostName, allowNewSession) {
  await az([
    "rest",
    "--method",
    "patch",
    "--url",
    sessionHostUrl(context, hostName),
    "--body",
    JSON.stringify({ properties: { allowNewSession } })
  ]);
}

async function sendSessionMessage(context, hostName, sessionId, title, body) {
  await az([
    "rest",
    "--method",
    "post",
    "--url",
    userSessionActionUrl(context, hostName, sessionId, "sendMessage"),
    "--body",
    JSON.stringify({ messageTitle: title, messageBody: body })
  ]);
}

async function gracefulDeallocate(body) {
  const { options, selected, notifiedSessions } = await drainAndNotify(body);
  if (options.cooldownMinutes > 0 && notifiedSessions.length > 0) {
    await wait(options.cooldownMinutes * 60 * 1000);
  }

  for (const target of selected) {
    await az(["vm", "deallocate", "--ids", target.vm.id, "--no-wait"]);
  }
  for (const target of selected) {
    await az(["vm", "wait", "--ids", target.vm.id, "--custom", "instanceView.statuses[?code=='PowerState/deallocated']"]);
  }

  return {
    deallocatedHosts: selected.map((target) => target.vm.name),
    notifiedSessions,
    cooldownMinutes: notifiedSessions.length ? options.cooldownMinutes : 0
  };
}

async function gracefulDeprovision(body) {
  const tfvars = await readTfvars();
  const { options, selected, notifiedSessions } = await drainAndNotify(body);
  if (options.cooldownMinutes > 0 && notifiedSessions.length > 0) {
    await wait(options.cooldownMinutes * 60 * 1000);
  }
  await applyTerraform({ sessionHostCount: 0, vmSize: body.vmSize || tfvars.vmSize });
  return {
    deprovisionedHosts: selected.map((target) => target.vm.name),
    notifiedSessions,
    cooldownMinutes: notifiedSessions.length ? options.cooldownMinutes : 0
  };
}

async function drainAndNotify(body) {
  const options = validateHostAction(body);
  const context = await deploymentContext();
  const [sessionHosts, vms] = await Promise.all([listSessionHosts(context), listVms(context)]);
  const selected = selectHosts(sessionHosts, vms, options.hostNames);
  const messageTitle = "Session host maintenance";
  const messageBody = `This session host is scheduled to be deallocated in ${options.cooldownMinutes} minute(s). Please save your work now.`;
  const notifiedSessions = [];

  for (const target of selected) {
    if (target.hostName) {
      await setAllowNewSession(context, target.hostName, false);
      const sessions = await listUserSessions(context, target.hostName);
      for (const session of sessions) {
        await sendSessionMessage(context, target.hostName, session.id, messageTitle, messageBody);
        notifiedSessions.push({
          host: target.vm.name,
          user: session.userPrincipalName || session.activeDirectoryUserName || "unknown",
          sessionState: session.sessionState
        });
      }
    }
  }

  return { options, selected, notifiedSessions };
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function applyTerraform(config) {
  if (config) {
    await writeTfvars({
      session_host_count: config.sessionHostCount,
      vm_size: config.vmSize
    });
  }
  await terraform(["fmt"]);
  await terraform(["validate"]);
  await terraform(["plan", "-out", "avd.tfplan"]);
  await terraform(["apply", "avd.tfplan"]);
}

async function runExclusive(name, work) {
  if (operation && operation.running) {
    const error = new Error(`Operation '${operation.name}' is already running.`);
    error.status = 409;
    throw error;
  }
  operation = { name, running: true, startedAt: new Date().toISOString(), finishedAt: null, error: null };
  try {
    const result = await work();
    operation = { ...operation, running: false, finishedAt: new Date().toISOString(), result };
    return result;
  } catch (error) {
    operation = { ...operation, running: false, finishedAt: new Date().toISOString(), error: error.message };
    throw error;
  }
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function validateConfig(body) {
  const sessionHostCount = Number(body.sessionHostCount);
  const vmSize = String(body.vmSize || "");
  if (!Number.isInteger(sessionHostCount) || sessionHostCount < 0 || sessionHostCount > 10) {
    const error = new Error("Session host count must be an integer from 0 to 10.");
    error.status = 400;
    throw error;
  }
  if (!vmSizes.includes(vmSize)) {
    const error = new Error(`VM size must be one of: ${vmSizes.join(", ")}`);
    error.status = 400;
    throw error;
  }
  return { sessionHostCount, vmSize };
}

function validateHostAction(body) {
  const hostNames = Array.isArray(body.hostNames) ? body.hostNames.map(String).filter(Boolean) : [];
  const cooldownMinutes = Number(body.cooldownMinutes ?? 5);
  if (!Number.isInteger(cooldownMinutes) || cooldownMinutes < 0 || cooldownMinutes > 60) {
    const error = new Error("Cool-down must be an integer from 0 to 60 minutes.");
    error.status = 400;
    throw error;
  }
  return { hostNames, cooldownMinutes };
}

function selectHosts(sessionHosts, vms, hostNames) {
  const wanted = new Set(hostNames.map((name) => name.toLowerCase()));
  const hostByVm = new Map();
  for (const host of sessionHosts) {
    const vmName = vmNameFromResourceId(host.resourceId);
    if (vmName) {
      hostByVm.set(vmName.toLowerCase(), sessionHostResourceName(host));
    }
  }
  const selectedVms = hostNames.length ? vms.filter((vm) => wanted.has(vm.name.toLowerCase())) : vms;
  if (!selectedVms.length) {
    const error = new Error("No matching session host VMs were selected.");
    error.status = 400;
    throw error;
  }
  return selectedVms.map((vm) => ({ vm, hostName: hostByVm.get(vm.name.toLowerCase()) }));
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/status") {
      json(res, 200, await status());
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/config/apply") {
      const config = validateConfig(await parseBody(req));
      json(res, 200, await runExclusive("apply configuration", () => applyTerraform(config)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/hosts/deallocate") {
      const body = await parseBody(req);
      json(res, 200, await runExclusive("cool-down and deallocate hosts", () => gracefulDeallocate(body)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/hosts/deprovision") {
      const body = await parseBody(req);
      json(res, 200, await runExclusive("cool-down and deprovision hosts", () => gracefulDeprovision(body)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/hosts/reprovision") {
      const config = validateConfig(await parseBody(req));
      if (config.sessionHostCount < 1) {
        const error = new Error("Reprovision requires at least 1 session host.");
        error.status = 400;
        throw error;
      }
      json(res, 200, await runExclusive("reprovision hosts", () => applyTerraform(config)));
      return;
    }
    if (req.method === "GET") {
      await serveStatic(url.pathname, res);
      return;
    }
    json(res, 404, { error: "Not found" });
  } catch (error) {
    json(res, error.status || 500, { error: error.message, operation });
  }
}

async function serveStatic(urlPath, res) {
  const safePath = urlPath === "/" ? "/index.html" : urlPath;
  const fullPath = path.normalize(path.join(publicDir, safePath));
  if (!fullPath.startsWith(publicDir)) {
    json(res, 403, { error: "Forbidden" });
    return;
  }
  try {
    const content = await fs.readFile(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    const type = ext === ".html" ? "text/html; charset=utf-8" : ext === ".js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8";
    text(res, 200, content, type);
  } catch (error) {
    json(res, 404, { error: "Not found" });
  }
}

http.createServer(route).listen(port, host, () => {
  console.log(`AVD web console running at http://${host}:${port}`);
});
