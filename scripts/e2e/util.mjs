// util.mjs — 测试公共工具：sleep / assert / 断言计数
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Assertion {
  constructor() {
    this.total = 0;
    this.failed = 0;
    this.failures = [];
  }

  check(name, ok, extra = '') {
    this.total++;
    if (ok) {
      console.log(`  ✓ ${name}`);
    } else {
      this.failed++;
      this.failures.push(name);
      console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`);
    }
    return ok;
  }

  summary() {
    console.log(`\n结果: ${this.total - this.failed}/${this.total} 通过`);
    if (this.failed > 0) {
      console.log('失败断言:');
      for (const f of this.failures) console.log(`  - ${f}`);
    }
    return this.failed === 0;
  }
}
