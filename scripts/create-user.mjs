import { scryptSync, randomBytes } from "node:crypto";
import pg from "pg";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log("用法: node scripts/create-user.mjs <username> <password> [role]");
    console.log("示例: node scripts/create-user.mjs myadmin mypassword123 admin");
    process.exit(1);
  }

  const [username, password, role = "admin"] = args;
  const dbUrl = process.env.DATABASE_URL || "postgresql://user:password@127.0.0.1:5432/ai_collab";
  const pool = new pg.Pool({ connectionString: dbUrl });

  try {
    const existing = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    if (existing.rows.length > 0) {
      console.error(`[Error]: 用户 ${username} 已存在！`);
      process.exit(1);
    }

    const passwordHash = hashPassword(password);
    const userId = `usr_${Date.now()}`;
    await pool.query(
      "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ($1, $2, $3, $4, NOW())",
      [userId, username, passwordHash, role]
    );

    console.log(`[Success]: 账户 ${username} 创建成功！(ID: ${userId}, Role: ${role})`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[Fatal]:", err.message);
  process.exit(1);
});
