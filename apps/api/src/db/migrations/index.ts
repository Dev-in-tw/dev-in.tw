import { sql as init } from "./0001_init.ts";
import { sql as privacy } from "./0002_privacy.ts";

/**
 * 依序套用的 migration。SQL 以字串模組存放，tsdown 會把它們一起打包進 dist/migrate.mjs 與
 * dist/server.mjs，runtime 映像不需要另外複製 .sql 檔。已發佈的 migration 不可修改，只能新增。
 */
export const migrations: readonly { id: string; sql: string }[] = [
  { id: "0001_init", sql: init },
  { id: "0002_privacy", sql: privacy },
];
