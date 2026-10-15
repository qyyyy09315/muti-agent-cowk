import { getStorageEngine } from "../apps/hub/src/db.js";
import { hashPassword } from "../apps/hub/src/auth.js";

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log("用法: node dist/scripts/create-user.js <username> <password> [role]");
    console.log("示例: node dist/scripts/create-user.js admin mypassword123 admin");
    process.exit(1);
  }

  const [username, password, role = "admin"] = args;
  const storage = getStorageEngine();
  await storage.init();

  try {
    const existing = await storage.getUserByUsername(username);
    if (existing) {
      console.error(`[Error]: 用户名 ${username} 已经存在！`);
      process.exit(1);
    }

    const passwordHash = hashPassword(password);
    const user = await storage.createUser({
      id: `usr_${Date.now()}`,
      username,
      passwordHash,
      role: role as any,
    });

    console.log(`[Success]: 账户 ${user.username} 创建成功！角色: ${user.role}`);
  } finally {
    await storage.close();
  }
}

main();
