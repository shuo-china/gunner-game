"""Reproduce the three original 300-entry InfVal relic tables, preserving precision.

Uses the read-only scene evidence helper. --check verifies the checked-in config and
fixture without writing; the default updates only these generated table sections.
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'AI-Workspace/Work/v1/tools'))
from read_original_feedback import read

parser = argparse.ArgumentParser()
parser.add_argument('--check', action='store_true')
args = parser.parse_args()
source = read('level0:123933')
fields = {'damageBalance': 'Damage_Balance', 'moneyBalance': 'Money_Balance', 'criticalDamageBalance': 'CriDmg_Balance'}
tables = {key: [f"{item['s_digits']}:{item['s_exponent']}" for item in source[name]] for key, name in fields.items()}
assert all(len(table) == 300 for table in tables.values())
lines = ['    // ORIGINAL_RELIC_BALANCES_BEGIN: raw InfVal coefficient:exponent; retain coefficient precision.']
for key, values in tables.items():
    lines.append(f'    {key}: [')
    for index in range(0, len(values), 10):
        lines.append('      ' + ', '.join(repr(item) for item in values[index:index + 10]) + ',')
    lines.append('    ],')
lines.append('    // ORIGINAL_RELIC_BALANCES_END')
config = ROOT / 'Project/assets/scripts/core/EconomyConfig.ts'
text = config.read_text(encoding='utf-8')
updated, count = re.subn(r'    // ORIGINAL_RELIC_BALANCES_BEGIN.*?    // ORIGINAL_RELIC_BALANCES_END', '\n'.join(lines), text, flags=re.S)
assert count == 1
fixture = ROOT / 'Project/tests/fixtures/original-relic-balances.json'
payload = json.dumps({'source': 'Cat Gunner 1.1.61 level0:123933', 'tables': tables, 'relics': source['Relic_list']}, ensure_ascii=False, indent=2) + '\n'
if args.check:
    assert updated == text, 'EconomyConfig relic tables differ from original scene'
    assert fixture.read_text(encoding='utf-8') == payload, 'Relic fixture differs from original scene'
else:
    config.write_text(updated, encoding='utf-8')
    fixture.parent.mkdir(parents=True, exist_ok=True)
    fixture.write_text(payload, encoding='utf-8')
print('Verified original 3 x 300 InfVal tables and 15 relic definitions' if args.check else 'Extracted original 3 x 300 InfVal tables and 15 relic definitions')
