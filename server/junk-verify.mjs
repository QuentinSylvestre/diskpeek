import { detectCategory } from './junk.js';
import rulesData from './rules.json' with { type: 'json' };

const rules = rulesData.rules;
const env = { TEMP: 'C:\\Windows\\Temp', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' };
const now = Math.floor(Date.now() / 1000);
const ago31d = now - 31 * 86400;
const ago91d = now - 91 * 86400;

let pass = 0, fail = 0;
function assert(desc, actual, expected) {
  if (actual === expected) { pass++; }
  else { fail++; console.error(`FAIL: ${desc} — got ${actual}, expected ${expected}`); }
}

// node_modules directory
assert('node_modules dir', detectCategory({path:'C:\\app\\node_modules',name:'node_modules',is_dir:true,mtime_unix:now}, rules, env), 'node_modules');
assert('node_modules file (not dir)', detectCategory({path:'C:\\app\\node_modules',name:'node_modules',is_dir:false,mtime_unix:now}, rules, env), null);

// python_cache
assert('__pycache__ dir', detectCategory({path:'C:\\app\\__pycache__',name:'__pycache__',is_dir:true,mtime_unix:now}, rules, env), 'python_cache');

// rust_build
assert('target dir', detectCategory({path:'C:\\app\\target',name:'target',is_dir:true,mtime_unix:now}, rules, env), 'rust_build');

// build_output
assert('build dir', detectCategory({path:'C:\\app\\build',name:'build',is_dir:true,mtime_unix:now}, rules, env), 'build_output');
assert('dist dir', detectCategory({path:'C:\\app\\dist',name:'dist',is_dir:true,mtime_unix:now}, rules, env), 'build_output');

// venv
assert('.venv dir', detectCategory({path:'C:\\app\\.venv',name:'.venv',is_dir:true,mtime_unix:now}, rules, env), 'venv');
assert('venv dir', detectCategory({path:'C:\\app\\venv',name:'venv',is_dir:true,mtime_unix:now}, rules, env), 'venv');
assert('.env file not venv', detectCategory({path:'C:\\app\\.env',name:'.env',is_dir:false,mtime_unix:now}, rules, env), null);
assert('.env dir not venv', detectCategory({path:'C:\\app\\.env',name:'.env',is_dir:true,mtime_unix:now}, rules, env), null);

// log
assert('old .log file', detectCategory({path:'C:\\app\\error.log',name:'error.log',is_dir:false,mtime_unix:ago31d}, rules, env), 'log');
assert('fresh .log file', detectCategory({path:'C:\\app\\error.log',name:'error.log',is_dir:false,mtime_unix:now}, rules, env), null);

// installer
assert('old .exe in Downloads', detectCategory({path:'C:\\Users\\test\\Downloads\\setup.exe',name:'setup.exe',is_dir:false,mtime_unix:ago91d}, rules, env), 'installer');
assert('fresh .exe in Downloads', detectCategory({path:'C:\\Users\\test\\Downloads\\setup.exe',name:'setup.exe',is_dir:false,mtime_unix:now}, rules, env), null);

// bin/obj false-positive regressions
assert('bin dir (no false positive)', detectCategory({path:'C:\\sdk\\bin',name:'bin',is_dir:true,mtime_unix:now}, rules, env), null);
assert('obj dir (no false positive)', detectCategory({path:'C:\\sdk\\obj',name:'obj',is_dir:true,mtime_unix:now}, rules, env), null);

// null mtime guard
assert('null mtime does not badge log', detectCategory({path:'C:\\app\\error.log',name:'error.log',is_dir:false,mtime_unix:null}, rules, env), null);

// zero mtime guard (FIX-1)
assert('zero mtime does not badge log', detectCategory({path:'C:\\app\\error.log',name:'error.log',is_dir:false,mtime_unix:0}, rules, env), null);

console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
