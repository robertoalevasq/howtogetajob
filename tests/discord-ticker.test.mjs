// tests/discord-ticker.test.mjs — sanitizeEmbed() clamping/validation.
// Added 2026-08-15 after two real HTTP 400 {"embeds":["0"]} failures
// (2026-08-09, 2026-08-12) got through the existing length-based clamps:
// an empty-but-present title/description/footer/author, and an embed with
// no visible content at all, both pass Discord's length limits while still
// failing its schema. Covers the two new guards plus the pre-existing
// clamping behavior so neither regresses silently again.
import { pass, fail } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { ROOT } from './helpers.mjs';

console.log('\ndiscord-ticker.mjs — sanitizeEmbed() clamping and validation');

try {
  const { sanitizeEmbed } = await import(
    pathToFileURL(join(ROOT, 'core', 'discord-ticker.mjs')).href
  );

  // Baseline: a normal embed passes through with its content intact.
  {
    const out = sanitizeEmbed({ title: 'Cycle running', description: 'Pass B: 3000/10108' });
    if (out.title === 'Cycle running' && out.description === 'Pass B: 3000/10108') {
      pass('a normal title+description embed passes through unchanged');
    } else {
      fail(`normal embed was altered: ${JSON.stringify(out)}`);
    }
  }

  // The two real 2026-08-09/08-12 failure shapes.
  {
    const out = sanitizeEmbed({ title: '', description: 'Pass B running' });
    if (!('title' in out)) pass('an empty-string title is omitted, not sent as ""');
    else fail(`empty-string title was kept: ${JSON.stringify(out)}`);
  }
  {
    const out = sanitizeEmbed({ title: 'Cycle running', description: '' });
    if (!('description' in out)) pass('an empty-string description is omitted, not sent as ""');
    else fail(`empty-string description was kept: ${JSON.stringify(out)}`);
  }
  {
    const out = sanitizeEmbed({ footer: { text: '' }, title: 'Cycle running' });
    if (!('footer' in out)) pass('an empty-string footer.text is omitted, not sent as ""');
    else fail(`empty-string footer was kept: ${JSON.stringify(out)}`);
  }
  {
    const out = sanitizeEmbed({ author: { name: '' }, title: 'Cycle running' });
    if (!('author' in out)) pass('an empty-string author.name is omitted, not sent as ""');
    else fail(`empty-string author was kept: ${JSON.stringify(out)}`);
  }

  // A content-less embed must be rejected loudly and locally, not sent.
  {
    let threw = false;
    try { sanitizeEmbed({}); } catch { threw = true; }
    if (threw) pass('a fully empty embed ({}) throws instead of producing a content-less payload');
    else fail('a fully empty embed should throw, not silently return {}');
  }
  {
    let threw = false;
    try { sanitizeEmbed({ title: '', description: '', color: '#ff0000' }); } catch { threw = true; }
    if (threw) pass('an embed with only color (no visible content) throws');
    else fail('color alone should not count as visible content');
  }
  {
    // Fields alone count as content — must NOT throw.
    let threw = false;
    try { sanitizeEmbed({ fields: [{ name: 'Status', value: 'Running' }] }); } catch { threw = true; }
    if (!threw) pass('an embed with only fields (no title/description) is accepted');
    else fail('fields alone should count as visible content, not throw');
  }

  // Pre-existing clamping behavior — must still work after this change.
  {
    const out = sanitizeEmbed({ title: 'x'.repeat(300) });
    if (out.title.length === 256) pass('an oversized title is still truncated to 256 chars');
    else fail(`title truncation regressed: length ${out.title.length}`);
  }
  {
    const out = sanitizeEmbed({ title: 'ok', color: '#00FF00' });
    if (out.color === 0x00ff00) pass('a hex color string is still normalized to a decimal int');
    else fail(`color normalization regressed: ${out.color}`);
  }
  {
    const out = sanitizeEmbed({ title: 'ok', fields: [{ name: '', value: '' }] });
    if (out.fields[0].name && out.fields[0].value) {
      pass('an empty field name/value still falls back to a zero-width space, not ""');
    } else {
      fail(`empty field fallback regressed: ${JSON.stringify(out.fields)}`);
    }
  }
} catch (e) {
  fail(`discord-ticker sanitizeEmbed tests crashed: ${e.message}`);
}
