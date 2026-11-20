const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ExcelJS = require("exceljs");
const { unzipSync } = require("fflate");
const { createService } = require("../electron/service.cjs");
const { defaults } = require("../electron/settings.cjs");
const { exportBatch } = require("../electron/exports.cjs");

const workerName =
  process.platform === "win32" ? "hydrocalc-worker.exe" : "hydrocalc-worker";
const headers = {
  "X-HydroCalc": "1",
};

async function wait(url, id) {
  // 等待真实工作进程，测试超时明确失败而不是无期限轮询。
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/analyses/${id}`);
    const record = await response.json();
    if (["completed", "failed"].includes(record.status)) return record;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("原生任务超时");
}

test("full API upload, settings, XLSX, ZIP and deletion", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "hydrocalc-service-"),
  );
  const service = await createService({
    dataDir: directory,
    webDir: path.resolve("web"),
    worker: path.resolve("dist/worker", workerName),
  });
  try {
    const { url } = service;
    const settings = {
      ...defaults,
      method: "binary",
      enable_clustering: false,
      resolution_width: 100,
      resolution_height: 100,
      theme: "dark",
    };
    const refused = await fetch(`${url}/api/settings`, {
      method: "PUT",
      body: JSON.stringify(settings),
    });
    assert.equal(refused.status, 400);
    const saved = await fetch(`${url}/api/settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify(settings),
    });
    assert.equal(saved.status, 200);
    const body = new FormData();
    const pixels = Buffer.alloc(100 * 100 * 3);
    const image = Buffer.concat([Buffer.from("P6\n100 100\n255\n"), pixels]);
    body.append("file", new Blob([image]), "中文 土壤.ppm");
    body.append("settings", JSON.stringify(settings));
    const response = await fetch(`${url}/api/analyses`, {
      method: "POST",
      headers,
      body,
    });
    assert.equal(response.status, 202);
    const submission = await response.json();
    const record = await wait(url, submission.id);
    assert.equal(record.status, "completed", record.error);
    assert.equal(record.metrics.stained_area_cm2, 2500);
    // 普通上传、历史查询、逐项导出和批量包应共享同一份根区指标。
    assert.equal(record.metrics.a_root, 8000);
    assert.equal(record.metrics.a_tot, 10000);
    assert.equal(record.metrics.es_percent, 100);
    assert.equal(record.settings.planned_wetting_depth_cm, 40);
    const history = service.repository.history();
    assert.deepEqual(history[0].metrics, record.metrics);
    const metricsResponse = await fetch(
      `${url}/api/analyses/${record.id}/export/metrics`,
    );
    const metricsCsv = await metricsResponse.text();
    assert.ok(metricsCsv.includes("a_root,8000"));
    assert.ok(metricsCsv.includes("es_percent,100"));
    const batchTarget = path.join(directory, "batch.zip");
    await exportBatch(service.repository, [record.id], batchTarget);
    const batchFiles = unzipSync(fs.readFileSync(batchTarget));
    const summary = Buffer.from(batchFiles["summary.csv"]).toString();
    assert.ok(
      summary.includes("rdpr_percent,ea_percent,es_percent,a_root,a_tot"),
    );
    assert.ok(summary.includes(",ok,"));

    // 真实读取 Excel 单元格，验证导出没有混入参考线颜色。
    const matrixResponse = await fetch(
      `${url}/api/analyses/${record.id}/export/matrix`,
    );
    assert.equal(matrixResponse.status, 200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await matrixResponse.arrayBuffer()));
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.rowCount, 100);
    assert.equal(sheet.getCell("A1").value, 0);
    assert.equal(sheet.getCell("CV100").value, 0);

    const bundleResponse = await fetch(
      `${url}/api/analyses/${record.id}/export/bundle`,
    );
    const bytes = new Uint8Array(await bundleResponse.arrayBuffer());
    const files = unzipSync(bytes);
    assert.ok(files["original.png"]);
    assert.ok(files["mask.png"]);
    assert.ok(files["wetting.png"]);
    assert.ok(files["profile.csv"]);
    assert.ok(files["matrix.csv"]);
    const metadata = JSON.parse(Buffer.from(files["result.json"]).toString());
    assert.equal(metadata.settings.soil_width_cm, 50);
    assert.deepEqual(metadata.metrics, record.metrics);
    assert.equal(metadata.root_zone.total_scope, "full_profile");
    const wettingResponse = await fetch(
      `${url}/api/analyses/${record.id}/images/wetting`,
    );
    assert.equal(wettingResponse.status, 200);
    assert.equal(wettingResponse.headers.get("content-type"), "image/png");

    // 旧历史缺少根区数据时照常导出，新增汇总列留空并明确 not_computed。
    const legacy = structuredClone(record);
    legacy.id = "f".repeat(32);
    legacy.metrics = {
      stained_ratio: 100,
    };
    delete legacy.root_zone;
    service.repository.put(legacy);
    await exportBatch(service.repository, [legacy.id], batchTarget);
    const legacyFiles = unzipSync(fs.readFileSync(batchTarget));
    const legacySummary = Buffer.from(legacyFiles["summary.csv"]).toString();
    assert.ok(legacySummary.includes(",not_computed,"));
    const legacyJsonName = Object.keys(legacyFiles).find((name) =>
      name.endsWith("/result.json"),
    );
    const legacyJson = JSON.parse(
      Buffer.from(legacyFiles[legacyJsonName]).toString(),
    );
    assert.equal(Object.hasOwn(legacyJson.metrics, "rdpr_percent"), false);
    service.repository.delete(legacy.id);

    // 无效 JSON 需要成为请求错误，不能从事件回调逃逸并终止整个应用。
    const invalidBody = new FormData();
    invalidBody.append("file", new Blob([image]), "bad.ppm");
    invalidBody.append("settings", "bad json");
    const invalid = await fetch(`${url}/api/analyses`, {
      method: "POST",
      headers,
      body: invalidBody,
    });
    assert.equal(invalid.status, 400);
    const bootstrap = await fetch(`${url}/api/bootstrap`);
    const info = await bootstrap.json();
    assert.equal(info.settings.theme, "dark");
    const deleted = await fetch(`${url}/api/analyses/${record.id}`, {
      method: "DELETE",
      headers,
    });
    assert.equal(deleted.status, 204);
    assert.equal(service.repository.history().length, 0);
  } finally {
    await service.close();
    fs.rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});

// 经由应用的普通设置与上传接口运行三种算法及关闭状态。
test("saved denoising selection reaches ordinary uploads and exported metadata", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "hydrocalc-denoise-"),
  );
  const service = await createService({
    dataDir: directory,
    webDir: path.resolve("web"),
    worker: path.resolve("dist/worker", workerName),
  });
  try {
    const pixels = Buffer.alloc(100 * 100 * 3);
    for (let offset = 0; offset < pixels.length; offset += 3) {
      pixels[offset + 2] = 255;
    }
    const image = Buffer.concat([Buffer.from("P6\n100 100\n255\n"), pixels]);
    for (const method of ["bilateral", "median", "nlm", "off"]) {
      const settings = {
        ...defaults,
        method: "hsv",
        denoise_enabled: method !== "off",
        denoise_method: method === "off" ? "nlm" : method,
        nlm_template_window: 3,
        nlm_search_window: 7,
        resolution_width: 100,
        resolution_height: 100,
        enable_clustering: true,
      };
      const saved = await fetch(`${service.url}/api/settings`, {
        method: "PUT",
        headers,
        body: JSON.stringify(settings),
      });
      assert.equal(saved.status, 200);
      const body = new FormData();
      body.append("file", new Blob([image]), `denoise-${method}.ppm`);
      const submission = await fetch(`${service.url}/api/analyses`, {
        method: "POST",
        headers,
        body,
      });
      assert.equal(submission.status, 202);
      const queued = await submission.json();
      const record = await wait(service.url, queued.id);
      assert.equal(record.status, "completed", record.error);
      assert.equal(
        record.preprocessing.method,
        method === "off" ? "none" : method,
      );
      assert.equal(record.algorithm_version, "2.4-planned-wetting");
      assert.equal(record.settings.denoise_method, settings.denoise_method);
      const response = await fetch(
        `${service.url}/api/analyses/${record.id}/export/bundle`,
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      const files = unzipSync(bytes);
      assert.ok(files["clusters.png"]);
      assert.ok(files["clusters_blurred.png"]);
      const exported = JSON.parse(Buffer.from(files["result.json"]).toString());
      assert.deepEqual(exported.preprocessing, record.preprocessing);
    }
  } finally {
    await service.close();
    fs.rmSync(directory, {
      recursive: true,
      force: true,
    });
  }
});
