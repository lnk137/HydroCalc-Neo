const assert = require("node:assert/strict");

async function measureCards(page, previewId = "") {
  // 测量已经渲染的位置，以画布为原点排除页面滚动，并取整消除亚像素误差。
  const workspace = page.locator(".card-workspace");
  return workspace.evaluate((surface, activeId) => {
    const origin = surface.getBoundingClientRect();
    const cards = [...surface.querySelectorAll(".workspace-card")];
    return cards.map((card) => {
      // 拖动中的浮动卡由占位轮廓代表，测量松手将采用的实际排列。
      const target =
        card.dataset.card === activeId
          ? surface.querySelector(".card-drop-target")
          : card;
      if (!target)
        throw new Error("Card drop preview disappeared before mouseup");
      const box = target.getBoundingClientRect();
      return {
        id: card.dataset.card,
        x: Math.round(box.x - origin.x),
        y: Math.round(box.y - origin.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    });
  }, previewId);
}

async function verifyWettingInspection(page, record) {
  // 在剖面的上缘和下缘检查读数，覆盖提示翻转和不同数据行。
  const drawing = page.locator(".explorer-drawing");
  await drawing.scrollIntoViewIfNeeded();
  const plot = drawing.locator("image").first();
  const box = await plot.boundingBox();
  const depth = page.locator(".root-controls input");
  const planned = await depth.inputValue();
  const readout = drawing.locator("[data-hover]");
  const formatter = new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: 2,
  });

  for (const fraction of [0.02, 0.98]) {
    const x = box.x + box.width * 0.35;
    const y = box.y + box.height * fraction;
    await page.mouse.move(x, y);
    await readout.waitFor();

    // 用灰线和数据行中心的对应关系核对数值，并检查文字没有超出 SVG 视口。
    const mark = await readout.evaluate((group) => {
      const svg = group.ownerSVGElement;
      const image = svg.querySelector("image");
      const line = group.querySelector("line");
      const tooltip = group.querySelector("rect").getBoundingClientRect();
      const frame = svg.getBoundingClientRect();
      const top = Number(image.getAttribute("y"));
      const span = Number(image.getAttribute("height"));
      const y = Number(line.getAttribute("y1"));
      return {
        fraction: (y - top) / span,
        inside: tooltip.top >= frame.top && tooltip.bottom <= frame.bottom,
      };
    });
    const rowIndex = Math.floor(mark.fraction * record.profile.length);
    const expected = record.profile[rowIndex];
    assert.ok(Math.abs(mark.fraction - fraction) < 0.025);
    assert.ok(mark.inside);
    const shownDepth = await readout.locator(".inspection-depth").textContent();
    const shownRatio = await readout.locator(".inspection-ratio").textContent();
    assert.equal(
      shownDepth.trim(),
      formatter.format(expected.depth_cm) + " cm",
    );
    assert.equal(
      shownRatio.trim(),
      "DC " + formatter.format(expected.ratio) + "%",
    );
  }

  // 灰线用于读数，离开绘图区即收起，计划湿润层保持原深度。
  await page.mouse.move(0, 0);
  await readout.waitFor({
    state: "hidden",
  });
  assert.equal(await depth.inputValue(), planned);
}

async function verifyCardWorkspace(page, reorderingScreenshot, record) {
  // 用真实 Electron 指针把图像卡拖到其下方的深度曲线后面。
  const image = page.locator('[data-card="image"]');
  const metrics = page.locator('[data-card="metrics"]');
  const reset = page.getByRole("button", {
    name: "重置布局",
    exact: true,
  });
  await page
    .getByRole("button", {
      name: "湿润层",
      exact: true,
    })
    .click();
  await reset.click();
  await page.waitForTimeout(400);
  const imageGrip = image.locator(".card-grip");
  await imageGrip.evaluate((handle) => {
    // 给后续 260 px 的鼠标轨迹留出足够视口空间。
    const top = handle.getBoundingClientRect().top;
    window.scrollBy(0, top - 160);
  });
  await imageGrip.hover();
  // 根区与优先流必须在同一张可拖动卡里，统计项保持完整。
  assert.equal(await page.locator(".workspace-card").count(), 4);
  assert.equal(await metrics.locator(".metric-group").count(), 2);
  assert.equal(await metrics.locator(".root-metrics dd").count(), 3);
  assert.equal(await metrics.locator(".metric-group:last-child dd").count(), 7);
  // 百分比用固定 100 刻度，剖面深度用实测高度，面积和长度指数仍显示原值。
  const verifyFraction = async (key, value, scale) => {
    const fill = metrics.locator(
      '[data-metric="' + key + '"] .metric-track > span',
    );
    if (!Number.isFinite(value)) {
      assert.equal(await fill.count(), 0, key);
      return;
    }
    const actual = await fill.evaluate((element) => {
      const matrix = new DOMMatrix(element.style.transform);
      return matrix.a;
    });
    assert.ok(Math.abs(actual - value / scale) < 0.00001, key);
  };
  await verifyFraction("stained_ratio", record.metrics.stained_ratio, 100);
  await verifyFraction(
    "matrix_depth_cm",
    record.metrics.matrix_depth_cm,
    record.settings.soil_height_cm,
  );
  await verifyFraction("rdpr_percent", record.metrics.rdpr_percent, 100);
  assert.equal(await metrics.locator('[data-metric="a_root"]').count(), 0);
  assert.equal(
    await metrics.locator('[data-metric="length_index"] .metric-track').count(),
    0,
  );
  const original = await measureCards(page);
  const originalImage = original.find((card) => card.id === "image");
  const originalResponse = original.find((card) => card.id === "response");
  const originalSaved = await page.evaluate(() =>
    localStorage.getItem("hydrocalc.cards.v2.wetting"),
  );
  const grip = await imageGrip.boundingBox();
  const startX = grip.x + grip.width / 2;
  const startY = grip.y + grip.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await image.and(page.locator(".is-active")).waitFor({
    timeout: 2000,
  });
  await page.mouse.move(startX + 24, startY + 260);

  // 松手前曲线应已填补首行，轮廓标出图像卡贴在曲线下方的位置。
  await page.waitForTimeout(240);
  const floating = await measureCards(page);
  const placeholderCount = await page.locator(".card-drop-target").count();
  assert.equal(placeholderCount, 1, JSON.stringify(floating));
  const dragged = floating.find((card) => card.id === "image");
  const preview = await measureCards(page, "image");
  const landing = preview.find((card) => card.id === "image");
  const movedResponse = preview.find((card) => card.id === "response");
  assert.ok(
    Math.abs(dragged.x - originalImage.x - 24) <= 1,
    JSON.stringify(floating),
  );
  assert.ok(
    Math.abs(dragged.y - originalImage.y - 260) <= 1,
    JSON.stringify(floating),
  );
  assert.equal(landing.x, originalImage.x);
  assert.equal(movedResponse.y, originalImage.y, JSON.stringify(preview));
  assert.equal(landing.y, movedResponse.y + originalResponse.height + 16);
  // 保持按住，反复离开和进入碰撞区。每次返回都应得到相同布局，位移不能累加。
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.mouse.move(startX, startY);
    await page.waitForTimeout(240);
    const returning = await measureCards(page, "image");
    assert.deepEqual(returning, original);
    await page.mouse.move(startX + 24, startY + 260);
    await page.waitForTimeout(240);
    const repeated = await measureCards(page, "image");
    assert.deepEqual(repeated, preview);
  }
  const savedDuring = await page.evaluate(() =>
    localStorage.getItem("hydrocalc.cards.v2.wetting"),
  );
  assert.equal(savedDuring, originalSaved);

  // 松手提交原来的预览，所有卡片错开，且只有当前模式的布局被更新。
  const standardBefore = await page.evaluate(() =>
    localStorage.getItem("hydrocalc.cards.v2.standard"),
  );
  await page.mouse.up();
  // 松手与补位使用同一段短过渡。等渲染到落点后再读实际布局。
  const settleTime = await image.evaluate((card) => {
    const animations = card.getAnimations();
    const motion = animations.find(
      (animation) => animation.transitionProperty === "transform",
    );
    return motion?.effect.getTiming().duration;
  });
  assert.ok(settleTime > 0 && settleTime <= 180, String(settleTime));
  await page.waitForTimeout(220);
  const released = await measureCards(page);
  assert.deepEqual(released, preview);
  for (const [index, first] of released.entries()) {
    for (const second of released.slice(index + 1)) {
      const separated =
        first.x + first.width <= second.x ||
        second.x + second.width <= first.x ||
        first.y + first.height <= second.y ||
        second.y + second.height <= first.y;
      assert.ok(separated, `${first.id} overlaps ${second.id}`);
    }
  }
  const saved = await page.evaluate(() => {
    const wetting = localStorage.getItem("hydrocalc.cards.v2.wetting");
    return {
      wetting: JSON.parse(wetting),
      standard: localStorage.getItem("hydrocalc.cards.v2.standard"),
    };
  });
  assert.deepEqual(saved.wetting.cards, preview);
  assert.equal(saved.standard, standardBefore);
  await page.screenshot({
    path: reorderingScreenshot,
    scale: "css",
  });
  await reset.click();
  await page.waitForTimeout(400);
  await image.scrollIntoViewIfNeeded();

  // 放缩的同一帧，图像与 DC 图使用共同深度轴；放下后其他卡片不重叠。
  const sizeBefore = await image.boundingBox();
  const edge = await image.locator('[data-edge="se"]').boundingBox();
  await page.mouse.move(edge.x + 8, edge.y + 8);
  await page.mouse.down();
  await page.mouse.move(edge.x + 64, edge.y + 56, {
    steps: 12,
  });
  await page.waitForTimeout(40);
  const sizeDuring = await image.boundingBox();
  assert.ok(
    Math.abs(sizeDuring.width - sizeBefore.width - 56) < 2,
    JSON.stringify({ sizeBefore, sizeDuring, edge }),
  );
  assert.ok(Math.abs(sizeDuring.height - sizeBefore.height - 48) < 2);
  await page.mouse.up();
  await page.waitForTimeout(400);
  await image.scrollIntoViewIfNeeded();
  const geometry = await page.locator(".explorer-drawing").evaluate((svg) => {
    const image = svg.querySelector("image").getBoundingClientRect();
    const curve = svg.querySelector("polyline").getBoundingClientRect();
    const canvas = svg.getBoundingClientRect();
    return {
      imageTop: image.top,
      imageBottom: image.bottom,
      curveTop: curve.top,
      curveBottom: curve.bottom,
      fill: image.height / canvas.height,
    };
  });
  assert.ok(Math.abs(geometry.imageTop - geometry.curveTop) < 2);
  assert.ok(Math.abs(geometry.imageBottom - geometry.curveBottom) < 2);
  assert.ok(geometry.fill > 0.8);
  await verifyWettingInspection(page, record);

  // 湿润层的自定义尺寸按模式保存；切换布局后还能恢复，当前深度与固定对比不丢失。
  const customSize = await image.boundingBox();
  const input = page.locator(".root-controls input");
  const originalDepth = await input.inputValue();
  await page
    .getByRole("button", {
      name: "固定当前深度对比",
      exact: true,
    })
    .click();
  // 按 Enter 自动保存一次，计算时仍显示湿润层，原有固定对比不丢失。
  assert.equal(
    await page.getByRole("button", { name: "重新分析", exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "应用深度", exact: true }).count(),
    0,
  );
  await input.fill("20.5");
  await input.press("Enter");
  await page.locator(".depth-progress").waitFor();
  await page.locator(".explorer-drawing").waitFor();
  await page.locator(".depth-progress").waitFor({ state: "hidden" });
  assert.equal(await input.inputValue(), "20.5");
  const updatedRoot = await metrics.locator(".root-metrics").textContent();
  // 模拟旧普通模式把根区卡和后续卡片留在 200 px 空白下面。
  await page.evaluate(() => {
    const workspace = document.querySelector(".card-workspace");
    const width = workspace.clientWidth;
    const gap = 16;
    const left = Math.round((width - gap) * 0.64);
    const right = width - left - gap;
    const cards = [
      { id: "image", x: 0, y: 0, width: left, height: 460 },
      { id: "results", x: left + gap, y: 0, width: right, height: 460 },
      { id: "root", x: 0, y: 676, width, height: 270 },
      { id: "response", x: 0, y: 962, width: left, height: 300 },
      { id: "details", x: left + gap, y: 962, width: right, height: 300 },
    ];
    const oldLayout = {
      width,
      cards,
    };
    localStorage.setItem(
      "hydrocalc.cards.v2.standard",
      JSON.stringify(oldLayout),
    );
  });
  await page
    .getByRole("button", {
      name: "原图",
      exact: true,
    })
    .click();
  await page.waitForTimeout(400);
  await image.scrollIntoViewIfNeeded();
  // 旧的两张指标卡合并到优先流卡原来的栏位，空出的位置由排版收回。
  const compacted = await measureCards(page);
  const migratedImage = compacted.find((card) => card.id === "image");
  const migratedMetrics = compacted.find((card) => card.id === "metrics");
  const migratedResponse = compacted.find((card) => card.id === "response");
  const migratedDetails = compacted.find((card) => card.id === "details");
  assert.equal(compacted.length, 4);
  assert.equal(migratedMetrics.x, migratedImage.width + 16);
  assert.equal(migratedMetrics.y, 0);
  assert.equal(migratedResponse.y, migratedImage.height + 16);
  assert.equal(migratedDetails.y, migratedMetrics.height + 16);
  assert.equal(await input.inputValue(), "20.5");
  assert.equal(
    await metrics.locator(".root-metrics").textContent(),
    updatedRoot,
  );
  await page
    .getByRole("button", {
      name: "湿润层",
      exact: true,
    })
    .click();
  await page.waitForTimeout(400);
  await image.scrollIntoViewIfNeeded();
  const restoredSize = await image.boundingBox();
  assert.ok(Math.abs(restoredSize.width - customSize.width) < 2);
  assert.ok(Math.abs(restoredSize.height - customSize.height) < 2);
  assert.equal(await page.locator(".response-comparisons > span").count(), 1);
  await page
    .getByRole("button", {
      name: "移除 " + originalDepth + " cm 对比",
      exact: true,
    })
    .click();
  await reset.click();
  await page.waitForTimeout(400);
  await image.scrollIntoViewIfNeeded();
  console.log(
    "Compact card drop, legacy gap migration, resize, shared axes and mode layouts passed",
  );
}

module.exports = {
  verifyCardWorkspace,
};
