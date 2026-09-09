const state = {
  data: null,
  busy: false
};

const elements = {
  operationStatus: document.querySelector("#operationStatus"),
  subscription: document.querySelector("#subscription"),
  accountUser: document.querySelector("#accountUser"),
  resourceGroup: document.querySelector("#resourceGroup"),
  workspace: document.querySelector("#workspace"),
  hostPool: document.querySelector("#hostPool"),
  hostCount: document.querySelector("#hostCount"),
  currentVmSize: document.querySelector("#currentVmSize"),
  hostSliderValue: document.querySelector("#hostSliderValue"),
  hostCountSlider: document.querySelector("#hostCountSlider"),
  cooldownValue: document.querySelector("#cooldownValue"),
  cooldownSlider: document.querySelector("#cooldownSlider"),
  vmSizeSelect: document.querySelector("#vmSizeSelect"),
  hostsTable: document.querySelector("#hostsTable"),
  telemetry: document.querySelector("#telemetry"),
  log: document.querySelector("#log"),
  refresh: document.querySelector("#refresh"),
  applyConfig: document.querySelector("#applyConfig"),
  reprovisionHosts: document.querySelector("#reprovisionHosts"),
  deallocateHosts: document.querySelector("#deallocateHosts"),
  deprovisionHosts: document.querySelector("#deprovisionHosts")
};

function setBusy(isBusy) {
  state.busy = isBusy;
  for (const button of document.querySelectorAll("button")) {
    button.disabled = isBusy;
  }
  elements.operationStatus.textContent = isBusy ? "Operation running..." : "Ready";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || "Request failed");
  }
  return body;
}

async function loadStatus() {
  try {
    const data = await api("/api/status");
    state.data = data;
    render(data);
  } catch (error) {
    elements.operationStatus.textContent = "Error";
    elements.log.textContent = error.message;
  }
}

function render(data) {
  elements.subscription.textContent = data.account.subscription || "-";
  elements.accountUser.textContent = data.account.user || "-";
  elements.resourceGroup.textContent = data.config.resourceGroupName;
  elements.workspace.textContent = `Workspace: ${data.config.workspaceName}`;
  elements.hostPool.textContent = data.config.hostPoolName;
  elements.hostCount.textContent = `${data.vms.length} VM resource(s), desired ${data.config.sessionHostCount}`;
  elements.currentVmSize.textContent = data.config.vmSize;
  elements.hostCountSlider.value = data.config.sessionHostCount;
  elements.hostSliderValue.textContent = data.config.sessionHostCount;

  if (!elements.vmSizeSelect.options.length) {
    for (const size of data.config.vmSizes) {
      const option = document.createElement("option");
      option.value = size;
      option.textContent = size;
      elements.vmSizeSelect.append(option);
    }
  }
  elements.vmSizeSelect.value = data.config.vmSize;

  const running = data.operation && data.operation.running;
  elements.operationStatus.textContent = running ? `${data.operation.name} running...` : "Ready";
  renderHosts(data);
  renderTelemetry(data);
  elements.log.textContent = JSON.stringify(data.operation || { message: "No operations yet." }, null, 2);
}

function renderHosts(data) {
  const hostsByVm = new Map();
  for (const host of data.sessionHosts) {
    const key = host.shortName.toLowerCase().replaceAll("-", "");
    hostsByVm.set(key, host);
  }
  const rows = data.vms.map((vm) => {
    const host = hostsByVm.get(vm.name.toLowerCase().replaceAll("-", "")) || {};
    return `
      <tr>
        <td><input class="host-select" type="checkbox" value="${escapeHtml(vm.name)}" checked></td>
        <td>${escapeHtml(vm.name)}</td>
        <td>${badge(host.status || "Not registered")}</td>
        <td>${escapeHtml(vm.powerState || "-")}</td>
        <td>${escapeHtml(vm.size || "-")}</td>
        <td>${escapeHtml(vm.privateIps || "-")}</td>
        <td>${formatDate(host.lastHeartBeat)}</td>
      </tr>
    `;
  });
  elements.hostsTable.innerHTML = rows.length ? rows.join("") : `<tr><td colspan="7">No session host VMs are currently provisioned.</td></tr>`;
}

function renderTelemetry(data) {
  if (!data.vms.length) {
    elements.telemetry.innerHTML = `<p class="hint">No VMs are provisioned, so there is no telemetry to chart.</p>`;
    return;
  }
  elements.telemetry.innerHTML = data.vms.map((vm) => {
    const metrics = data.metrics[vm.name] || {};
    if (metrics.unavailable) {
      return `<article class="metric-card"><h3>${escapeHtml(vm.name)}</h3><p class="warn">${escapeHtml(metrics.message)}</p></article>`;
    }
    return `
      <article class="metric-card">
        <h3>${escapeHtml(vm.name)}</h3>
        ${metricBlock("CPU", metrics["Percentage CPU"], "%")}
        ${metricBlock("Available memory", metrics["Available Memory Bytes"], "bytes")}
        ${metricBlock("Network in", metrics["Network In Total"], "bytes")}
        ${metricBlock("Network out", metrics["Network Out Total"], "bytes")}
        ${metricBlock("Disk read", metrics["Disk Read Bytes"], "bytes")}
        ${metricBlock("Disk write", metrics["Disk Write Bytes"], "bytes")}
      </article>
    `;
  }).join("");
}

function metricBlock(label, points, unit) {
  const data = Array.isArray(points) ? points : [];
  const latest = data.length ? data[data.length - 1].value : null;
  return `
    <div>
      <div class="metric-title">
        <span>${escapeHtml(label)}</span>
        <strong>${latest === null ? "No data" : formatMetric(latest, unit)}</strong>
      </div>
      ${sparkline(data)}
    </div>
  `;
}

function sparkline(points) {
  if (!points.length) {
    return `<svg class="chart" role="img" aria-label="No metric data"></svg>`;
  }
  const values = points.map((point) => Number(point.value));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const coords = values.map((value, index) => {
    const x = values.length === 1 ? 100 : (index / (values.length - 1)) * 100;
    const y = 90 - ((value - min) / range) * 80;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  return `<svg class="chart" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Metric trend"><polyline points="${coords}" fill="none" stroke="var(--cp-accent)" stroke-width="3" vector-effect="non-scaling-stroke"></polyline></svg>`;
}

function selectedConfig() {
  return {
    sessionHostCount: Number(elements.hostCountSlider.value),
    vmSize: elements.vmSizeSelect.value
  };
}

function selectedHostAction() {
  const hostNames = Array.from(document.querySelectorAll(".host-select:checked")).map((checkbox) => checkbox.value);
  return {
    hostNames,
    cooldownMinutes: Number(elements.cooldownSlider.value)
  };
}

async function runAction(path, body) {
  setBusy(true);
  try {
    const result = await api(path, {
      method: "POST",
      body: JSON.stringify(body || {})
    });
    elements.log.textContent = JSON.stringify(result, null, 2);
    await loadStatus();
  } catch (error) {
    elements.log.textContent = error.message;
  } finally {
    setBusy(false);
  }
}

function badge(value) {
  const className = value === "Available" ? "ok" : value.includes("deallocated") ? "warn" : "";
  return `<span class="${className}">${escapeHtml(value)}</span>`;
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "-";
}

function formatMetric(value, unit) {
  if (unit === "%") {
    return `${value.toFixed(1)}%`;
  }
  if (unit === "bytes") {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let scaled = value;
    let index = 0;
    while (scaled >= 1024 && index < units.length - 1) {
      scaled /= 1024;
      index += 1;
    }
    return `${scaled.toFixed(1)} ${units[index]}`;
  }
  return value.toFixed(1);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

elements.hostCountSlider.addEventListener("input", () => {
  elements.hostSliderValue.textContent = elements.hostCountSlider.value;
});
elements.cooldownSlider.addEventListener("input", () => {
  elements.cooldownValue.textContent = elements.cooldownSlider.value;
});
elements.refresh.addEventListener("click", loadStatus);
elements.applyConfig.addEventListener("click", () => runAction("/api/config/apply", selectedConfig()));
elements.reprovisionHosts.addEventListener("click", () => runAction("/api/hosts/reprovision", selectedConfig()));
elements.deallocateHosts.addEventListener("click", () => runAction("/api/hosts/deallocate", selectedHostAction()));
elements.deprovisionHosts.addEventListener("click", () => runAction("/api/hosts/deprovision", {
  vmSize: elements.vmSizeSelect.value,
  cooldownMinutes: Number(elements.cooldownSlider.value)
}));

loadStatus();
