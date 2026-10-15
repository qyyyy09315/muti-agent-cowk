import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { UnityBridge } from "../packages/uvcs-workspace/src/unity-bridge.js";

async function runDoctor() {
  console.log("=================================================");
  console.log("       AI-Collab 系统健康自检 (collab doctor)     ");
  console.log("=================================================\n");

  let allOk = true;

  // 1. Node 环境核验
  const nodeVer = process.version;
  console.log(`[1] Node.js 运行环境: ${nodeVer} ... ✔ 通过`);

  // 2. Hub 服务连通性
  const hubUrl = process.env.HUB_URL || "http://127.0.0.1:3100";
  try {
    const res = await fetch(`${hubUrl}/healthz`);
    if (res.ok) {
      const data = await res.json();
      console.log(`[2] Hub 控制平面连通性 (${hubUrl}): 200 OK (${JSON.stringify(data)}) ... ✔ 通过`);
    } else {
      console.warn(`[2] Hub 控制平面连通性 (${hubUrl}): HTTP ${res.status} ... ⚠️ 异常`);
      allOk = false;
    }
  } catch (err) {
    console.warn(`[2] Hub 控制平面连通性 (${hubUrl}): 无法连接 (${(err as Error).message}) ... ⚠️ 异常`);
    allOk = false;
  }

  // 3. Unity Version Control (cm CLI) 核验
  try {
    const cmVer = execSync("cm version", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    console.log(`[3] UVCS Plastic SCM (cm CLI): ${cmVer.trim()} ... ✔ 通过`);
  } catch {
    console.log(`[3] UVCS Plastic SCM (cm CLI): 未检测到 cm 命令（将采用安全 Mock 降级模式） ... ℹ 提示`);
  }

  // 4. Unity 工程与 .meta 完整性检查（如果提供了 WORKSPACE_DIR）
  const wsDir = process.env.WORKSPACE_DIR || process.cwd();
  const unityVersion = UnityBridge.getProjectVersion(wsDir);
  console.log(`[4] 目标工程 Unity 版本: ${unityVersion}`);

  const metaAudit = UnityBridge.auditMetaFiles(wsDir);
  if (metaAudit.valid) {
    console.log(`[5] Assets 资源与 .meta GUID 完整性: 完全合规，无孤儿或缺失 ... ✔ 通过`);
  } else {
    console.warn(`[5] Assets 资源与 .meta GUID 完整性: 发现 ${metaAudit.missingMetas.length} 处丢失，${metaAudit.orphanMetas.length} 处孤儿 ... ⚠️ 需注意`);
  }

  // 6. 本地认证检查
  if (process.env.HUB_TOKEN) {
    console.log(`[6] 访问凭据 (HUB_TOKEN): 已配置 ... ✔ 通过`);
  } else {
    console.log(`[6] 访问凭据 (HUB_TOKEN): 未配置（仅用于公开接口或本地测试） ... ℹ 提示`);
  }

  console.log("\n-------------------------------------------------");
  if (allOk) {
    console.log("🎉 自检完毕：系统基础环境状态良好，可正常启动 Worker！");
  } else {
    console.log("⚠️ 自检完毕：部分项存在异常，请根据上方提示核实。");
  }
  console.log("-------------------------------------------------");
}

runDoctor().catch(console.error);
