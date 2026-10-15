import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { UVCSClient, UnityBridge } from "../src/index.js";

test("UVCSClient raises CollabError when cm binary is missing", async () => {
  const client = new UVCSClient("non_existent_cm_bin_12345");
  await assert.rejects(async () => {
    await client.getStatus(process.cwd());
  }, /执行 cm 命令失败/);
});

test("UnityBridge buildBatchmodeArgs produces valid arguments", () => {
  const args = UnityBridge.buildBatchmodeArgs({
    projectPath: "F:/UnityProjects/Demo",
    logFile: "Editor.log",
    runTests: true,
    testPlatform: "EditMode",
    testResultsXml: "results.xml",
  });
  assert.deepEqual(args, [
    "-projectPath",
    "F:/UnityProjects/Demo",
    "-batchmode",
    "-nographics",
    "-logFile",
    "Editor.log",
    "-runTests",
    "-testPlatform",
    "EditMode",
    "-testResults",
    "results.xml",
  ]);
});

test("UnityBridge auditMetaFiles detects missing and orphan metas", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "unity_test_"));
  const assetsDir = path.join(tmpDir, "Assets");
  fs.mkdirSync(assetsDir);

  // 1. 创建合法对
  fs.writeFileSync(path.join(assetsDir, "Player.cs"), "// csharp");
  fs.writeFileSync(path.join(assetsDir, "Player.cs.meta"), "guid: 123");

  // 2. 创建缺失 .meta 的文件
  fs.writeFileSync(path.join(assetsDir, "MissingMeta.cs"), "// code");

  // 3. 创建孤儿 .meta（实体已不存在）
  fs.writeFileSync(path.join(assetsDir, "Orphan.prefab.meta"), "guid: 456");

  const audit = UnityBridge.auditMetaFiles(tmpDir);
  assert.equal(audit.valid, false);
  assert.equal(audit.missingMetas.length, 1);
  assert.ok(audit.missingMetas[0].includes("MissingMeta.cs"));
  assert.equal(audit.orphanMetas.length, 1);
  assert.ok(audit.orphanMetas[0].includes("Orphan.prefab.meta"));
});

test("UnityBridge parseCompileErrors catches C# errors", () => {
  const sampleLog = `
DisplayProgressNotification: Build
Assets/Scripts/Landmark.cs(14,21): error CS0246: The type or namespace name 'ILandmarkData' could not be found
UnityEngine.Debug:LogError(Object)
Assets/Scripts/Manager.cs(40,10): error CS1002: ; expected
Compilation failed: 2 error(s), 0 warnings
`;
  const errors = UnityBridge.parseCompileErrors(sampleLog);
  assert.equal(errors.length, 3);
  assert.ok(errors[0].includes("CS0246"));
  assert.ok(errors[1].includes("CS1002"));
});
