function locator(page, target) {
  if (target.testId) return page.getByTestId(target.testId);
  if (target.role) return page.getByRole(target.role, { name: target.name, exact: true });
  return page.locator(target.selector);
}

async function executeStep(page, step, { storage, width, height, started, guard, marks, screenshots, view }) {
  const target = step.target && locator(page, step.target);
  if (step.action === 'click') await target.click();
  if (step.action === 'fill') await target.fill(step.value);
  if (step.action === 'wait') await target.waitFor({ state: 'visible' });
  if (step.action === 'expectText') {
    await target.waitFor({ state: 'visible' });
    const deadline = Date.now() + 10000;
    while (!(await target.innerText()).includes(step.text)) {
      if (Date.now() > deadline) throw new Error('No apareció el texto esperado');
      guard(); await page.waitForTimeout(100);
    }
  }
  if (step.action === 'hold') await page.waitForTimeout(step.milliseconds);
  if (step.action === 'mark') marks.push({ label: step.label, seconds: (performance.now() - started) / 1000, ...(view ? { view } : {}) });
  if (step.action === 'frame') {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error('Elemento no visible para encuadrar');
    const x = Math.max(0, box.x - step.padding), y = Math.max(0, box.y - step.padding);
    const right = Math.min(width, box.x + box.width + step.padding);
    const bottom = Math.min(height, box.y + box.height + step.padding);
    if (right <= x || bottom <= y) throw new Error('Elemento fuera del viewport');
    marks.push({ label: step.label, seconds: (performance.now() - started) / 1000, ...(view ? { view } : {}),
      region: { x: x / width, y: y / height, width: (right - x) / width, height: (bottom - y) / height }, coordinateSpace: 'browser-viewport-normalized' });
  }
  if (step.action === 'screenshot') {
    const file = storage.freshPath('png'); await (target || page).screenshot({ path: file });
    screenshots.push({ ...storage.fileEntry(file), ...(view ? { view } : {}) });
  }
}
module.exports = { executeStep };
