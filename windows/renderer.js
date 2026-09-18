let state = { revision: 0, routes: [], windows: [], threads: [], switchModels: [], todayUsage: null, fallbacks: [] };
const byId = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch]));

async function call(command, args, input) {
  const result = await window.cma.call(command, args || [], input == null ? null : input);
  if (!result || result.ok === false) throw new Error(result && result.message || "操作失败");
  return result;
}

function setStatus(message, error) {
  const node = byId("status");
  node.textContent = message || "";
  node.style.color = error ? "#ff7d7d" : "";
}

function routeById(id) { return state.routes.find((item) => item.id === id); }

function renderUsage() {
  const u = state.todayUsage;
  const hosts = u && u.hosts ? Object.entries(u.hosts).map(([k,v]) => k + " ×" + v).join(" · ") : "今天还没有网关请求";
  byId("usage").textContent = hosts;
}

function renderWindows() {
  const target = byId("windows");
  const items = state.windows || [];
  if (!items.length) { target.innerHTML = '<div class="empty">还没有窗口</div>'; return; }
  target.innerHTML = items.map((w) => {
    const current = state.switchModels.find((m) => m.slug === w.currentModel || m.id === w.currentModel || m.model === w.currentModel);
    const initial = routeById(w.initialModel);
    return '<article class="card"><div class="card-head"><div><div class="title">' + escapeHtml(w.name || w.id) + '</div><div class="muted">' + escapeHtml(w.id) + '</div></div><span class="badge ' + (w.running ? "ok" : "") + '">' + (w.running ? "运行中 · PID " + (w.pid || "") : "未运行") + '</span></div><div>当前模型：' + escapeHtml(current && current.name || w.currentModel || "未选择") + '</div><div class="muted">起始模型：' + escapeHtml(initial && initial.name || w.initialModel || "自动") + '</div><div class="card-actions"><button data-win-open="' + escapeHtml(w.id) + '">打开</button>' + (w.running ? '<button data-win-close="' + escapeHtml(w.id) + '">关闭</button>' : '') + '</div></article>';
  }).join("");
}

function renderThreads() {
  const target = byId("threads");
  const rows = state.threads || [];
  if (!rows.length) { target.innerHTML = '<div class="empty">最近 30 分钟没有活跃对话</div>'; return; }
  target.innerHTML = rows.slice(0, 12).map((t) => {
    const billing = t.billing || {};
    return '<div class="list-row"><strong>' + escapeHtml(t.scope || t.place || "?") + '</strong><span title="' + escapeHtml(t.title || "") + '">' + escapeHtml(t.title || String(t.id || "").slice(0,8)) + '</span><code>' + escapeHtml(t.model || "未知模型") + '</code><span class="billing-' + escapeHtml(billing.kind || "unknown") + '">' + escapeHtml(billing.label || "未知上游") + '</span><span class="muted">' + escapeHtml(t.minutesAgo == null ? "" : t.minutesAgo + " 分钟") + '</span></div>';
  }).join("");
}

function renderModels() {
  const showArchived = byId("showArchived").checked;
  const routes = (state.routes || []).filter((r) => showArchived || !r.archived);
  const target = byId("models");
  target.innerHTML = routes.map((r) => {
    const official = r.protocol === "oauth";
    const ready = !!r.model && (r.noKey || r.hasKey || r.protocol === "oauth" || r.protocol === "chatgpt");
    const statusClass = r.verifiedAt ? "ok" : (ready ? "" : "warn");
    const statusText = r.archived ? "已归档" : (r.verifiedAt ? "已验证" : (ready ? "待验证" : "待配置"));
    return '<article class="card"><div class="card-head"><div><div class="title">' + escapeHtml(r.name) + '</div><div class="muted">' + escapeHtml(r.vendor || "") + '</div></div><span class="badge ' + statusClass + '">' + statusText + '</span></div><code>' + escapeHtml(r.model || "") + '</code><div class="muted">' + escapeHtml(r.endpoint || (official ? "ChatGPT 登录" : "")) + '</div><div class="card-actions"><button data-open-model="' + escapeHtml(r.id) + '">打开 Codex</button>' + (official ? "" : '<button data-edit-model="' + escapeHtml(r.id) + '">编辑</button><button data-check-model="' + escapeHtml(r.id) + '">检查连接</button><button data-probe-model="' + escapeHtml(r.id) + '">真实验证</button>') + '</div></article>';
  }).join("") || '<div class="empty">模型库为空</div>';

  const options = (state.switchModels || []).map((m) => '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.name) + '</option>').join("");
  byId("newWindowModel").innerHTML = options;
}

function renderFallbacks() {
  if (state.fallbacks && state.fallbacks.length) {
    const f = state.fallbacks[0];
    setStatus("最近有自动备用：" + f.fromName + " → " + f.toName + "。备用条目按自己的账户计费。", false);
  }
}

function accept(data) {
  state = { ...state, ...data };
  renderUsage(); renderWindows(); renderThreads(); renderModels(); renderFallbacks();
}

async function refresh() {
  setStatus("正在刷新…");
  try {
    await call("start-gateway");
    const data = await call("library");
    accept(data);
    setStatus(data.message || "已刷新");
  } catch (error) {
    setStatus(error.message, true);
  }
}

function openEditor(route) {
  const isNew = !route;
  const current = route || { id: "model-" + crypto.randomUUID().replaceAll("-","").slice(0,20), name:"", vendor:"自定义", endpoint:"https://api.deepseek.com/v1", protocol:"responses", model:"", notes:"", docs:"", credentialID:"", noKey:false, archived:false, switchable:true, fallback:"", contextWindow:0 };
  byId("dialogTitle").textContent = isNew ? "新增模型" : "编辑模型";
  byId("modelId").value = current.id || "";
  byId("modelName").value = current.name || "";
  byId("modelVendor").value = current.vendor || "";
  byId("modelModel").value = current.model || "";
  byId("modelProtocol").value = current.protocol || "responses";
  byId("modelEndpoint").value = current.endpoint || "";
  byId("modelKey").value = "";
  byId("modelContext").value = current.contextWindow || "";
  byId("modelNoKey").checked = !!current.noKey;
  byId("modelSwitchable").checked = current.switchable !== false;
  byId("modelFallback").innerHTML = '<option value="">不设置</option>' + (state.routes || []).filter((x) => x.id !== current.id && x.protocol !== "oauth" && !x.archived).map((x) => '<option value="' + escapeHtml(x.id) + '">' + escapeHtml(x.name) + '</option>').join("");
  byId("modelFallback").value = current.fallback || "";
  byId("modelDialog").showModal();
}

async function saveEditor(event) {
  event.preventDefault();
  const id = byId("modelId").value;
  const prior = routeById(id) || {};
  const route = {
    ...prior,
    id,
    name: byId("modelName").value.trim(),
    vendor: byId("modelVendor").value.trim() || "自定义",
    endpoint: byId("modelEndpoint").value.trim(),
    protocol: byId("modelProtocol").value,
    model: byId("modelModel").value.trim(),
    notes: prior.notes || "",
    docs: prior.docs || "",
    credentialID: prior.credentialID || id,
    noKey: byId("modelNoKey").checked,
    archived: !!prior.archived,
    hidden: !!prior.hidden,
    switchable: byId("modelSwitchable").checked,
    fallback: byId("modelFallback").value,
    contextWindow: Number(byId("modelContext").value || 0)
  };
  try {
    setStatus("正在保存…");
    const result = await call("save", [], { route, revision: state.revision, key: byId("modelKey").value, clearKey: false });
    byId("modelDialog").close();
    accept(result);
    await refresh();
  } catch (error) { setStatus(error.message, true); }
}

document.addEventListener("click", async (event) => {
  const el = event.target.closest("button");
  if (!el) return;
  try {
    if (el.dataset.editModel) return openEditor(routeById(el.dataset.editModel));
    if (el.dataset.openModel) { setStatus("正在打开 Codex…"); accept(await call("open-codex", [el.dataset.openModel])); return; }
    if (el.dataset.checkModel) { setStatus("正在检查连接…"); setStatus((await call("check", [el.dataset.checkModel])).message || "连接正常"); return; }
    if (el.dataset.probeModel) { setStatus("正在真实验证…"); accept(await call("probe", [el.dataset.probeModel])); return; }
    if (el.dataset.winOpen) { setStatus("正在打开窗口…"); accept(await call("open-window", [el.dataset.winOpen])); return; }
    if (el.dataset.winClose) { setStatus("正在关闭窗口…"); accept(await call("close-window", [el.dataset.winClose])); return; }
  } catch (error) { setStatus(error.message, true); }
});

byId("refreshBtn").addEventListener("click", refresh);
byId("diagBtn").addEventListener("click", async () => { try { setStatus("正在诊断…"); setStatus((await call("diagnostics")).message || "诊断完成"); } catch(e){ setStatus(e.message,true); } });
byId("dataBtn").addEventListener("click", () => window.cma.openDataDir());
byId("addBtn").addEventListener("click", () => openEditor(null));
byId("showArchived").addEventListener("change", renderModels);
byId("newWindowBtn").addEventListener("click", async () => { try { const id = byId("newWindowModel").value; setStatus("正在新建窗口…"); accept(await call("new-window", [id])); } catch(e){ setStatus(e.message,true); } });
byId("modelForm").addEventListener("submit", saveEditor);

(async () => {
  const info = await window.cma.platform();
  byId("subtitle").textContent = "Windows Preview · v" + info.version + " · " + info.arch;
  await refresh();
})();
