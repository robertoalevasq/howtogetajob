import { pass, fail, ROOT } from './helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\npreflight-check.mjs — clearance/location keyword gate');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'core', 'preflight-check.mjs')).href);

  // Clearance hard stop
  const g1 = mod.checkGate('Must hold an active TS/SCI clearance.', { clearance: { status: 'None', accepts_sponsorship: false } });
  if (g1.pass === false && /clearance/.test(g1.reason)) pass('checkGate hard-stops on unsponsored clearance mismatch');
  else fail(`checkGate clearance hard-stop => ${JSON.stringify(g1)}`);

  // Clearance mentioned but sponsorship accepted -> soft, not a hard stop
  const g2 = mod.checkGate('Must hold an active Secret clearance.', { clearance: { status: 'None', accepts_sponsorship: true } });
  if (g2.pass === true) pass('checkGate does not hard-stop when candidate accepts clearance sponsorship');
  else fail(`checkGate should pass with accepts_sponsorship=true => ${JSON.stringify(g2)}`);

  // No clearance language at all
  const g3 = mod.checkGate('We are looking for a backend engineer.', { clearance: { status: 'None', accepts_sponsorship: false } });
  if (g3.pass === true) pass('checkGate passes when the JD mentions no clearance requirement');
  else fail(`checkGate false positive on clean JD => ${JSON.stringify(g3)}`);

  // Missing clearance profile block entirely -> never crash, never false-positive
  const g4 = mod.checkGate('Requires an active Top Secret clearance.', {});
  if (g4.pass === false) pass('checkGate defaults an absent clearance block to "None" and still hard-stops');
  else fail(`checkGate with no clearance block => ${JSON.stringify(g4)}`);

  // Onsite vs. remote_only hard stop
  const g5 = mod.checkGate('This is an onsite only role, 5 days in office required.', { location: { work_mode: 'remote_only' } });
  if (g5.pass === false && /location/.test(g5.reason)) pass('checkGate hard-stops onsite-only JD against remote_only candidate');
  else fail(`checkGate onsite hard-stop => ${JSON.stringify(g5)}`);

  // Onsite language but candidate has no strict remote requirement
  const g6 = mod.checkGate('This is an onsite only role.', { location: { work_mode: 'no_preference' } });
  if (g6.pass === true) pass('checkGate does not flag onsite-only JDs for a candidate with no_preference');
  else fail(`checkGate should pass with no_preference => ${JSON.stringify(g6)}`);

  // Empty text / empty profile — never throws
  const g7 = mod.checkGate('', {});
  const g8 = mod.checkGate('Some JD text.', undefined);
  if (g7.pass === true && g8.pass === true) pass('checkGate handles empty text and missing profile without throwing');
  else fail(`checkGate empty-input handling => ${JSON.stringify(g7)} / ${JSON.stringify(g8)}`);

  // Sci-fi false-positive fix: lowercase "sci-fi" should NOT trigger clearance hard-stop
  const g9 = mod.checkGate('This is a sci-fi themed adventure game studio.', { clearance: { status: 'None', accepts_sponsorship: false } });
  if (g9.pass === true) pass('checkGate does not false-positive on "sci-fi" (case-sensitive SCI check)');
  else fail(`checkGate sci-fi false-positive => ${JSON.stringify(g9)}`);

  // But uppercase SCI should still trigger the hard-stop
  const g10 = mod.checkGate('We require a TS/SCI clearance for this role.', { clearance: { status: 'None', accepts_sponsorship: false } });
  if (g10.pass === false && /clearance/.test(g10.reason)) pass('checkGate still catches uppercase SCI in TS/SCI context');
  else fail(`checkGate uppercase SCI still blocks => ${JSON.stringify(g10)}`);

  // Lowercase clearance.status in the profile must behave identically to "None"
  const g12 = mod.checkGate('Requires an active Top Secret clearance.', { clearance: { status: 'none', accepts_sponsorship: false } });
  if (g12.pass === false && /clearance/.test(g12.reason)) pass('checkGate hard-stops on a lowercase clearance.status of "none"');
  else fail(`checkGate lowercase clearance.status => ${JSON.stringify(g12)}`);

  // ...as must odd casing/whitespace
  const g13 = mod.checkGate('Requires an active Top Secret clearance.', { clearance: { status: '  NONE ', accepts_sponsorship: false } });
  if (g13.pass === false) pass('checkGate normalizes casing and whitespace around clearance.status');
  else fail(`checkGate padded/uppercase clearance.status => ${JSON.stringify(g13)}`);

  // Standalone uppercase SCI should trigger
  const g11 = mod.checkGate('Must have an active SCI clearance.', { clearance: { status: 'None', accepts_sponsorship: false } });
  if (g11.pass === false && /clearance/.test(g11.reason)) pass('checkGate catches standalone uppercase SCI');
  else fail(`checkGate standalone SCI blocks => ${JSON.stringify(g11)}`);
} catch (err) {
  fail(`preflight-check gate tests crashed: ${err.stack || err.message}`);
}
