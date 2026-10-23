"""Independent integer-coefficient transcription of recovered InfVal ARM64 operators.

Run from any directory: python Project/tests/fixtures/rebirth-oracle.py
This generates rebirth-golden.json without importing the TypeScript implementation.
The embedded source hashes pin both the manager pseudocode and actual ARM64 library.
"""
import hashlib
import json
import math
import pathlib
from decimal import Decimal

ROOT = pathlib.Path(__file__).resolve().parents[3]


def quot(a, b):
    return (abs(a) // abs(b)) * (-1 if (a < 0) != (b < 0) else 1)


class Inf:
    def __init__(self, coefficient, exponent=0):
        self.n, self.e = coefficient, exponent

    @property
    def p(self):
        return max(1, 1 - self.e) if self.n == 0 else len(str(abs(self.n)))

    def at(self, exponent):
        shift = self.e - exponent
        return Inf(self.n * 10**shift if shift >= 0 else quot(self.n, 10**-shift), exponent)

    def precision(self, precision):
        return self.at(self.e + self.p - precision)

    @staticmethod
    def double(value):
        decimal = Decimal(format(value, '.17g'))
        sign, digits, exponent = decimal.as_tuple()
        return Inf(int(''.join(map(str, digits))) * (-1 if sign else 1), exponent).precision(17)

    def add(self, other, subtract=False):
        p = max(self.p, other.p)
        if not self.n:
            return Inf(-other.n if subtract else other.n, other.e).precision(p)
        if not other.n:
            return self.precision(p)
        e = max(self.e + self.p - p, other.e + other.p - p)
        a, b = self.at(e).n, other.at(e).n
        return Inf(a - b if subtract else a + b, e).precision(p)

    def mul(self, other):
        p = max(self.p, other.p)
        if not self.n or not other.n:
            return Inf(0).precision(p)
        return Inf(self.n * other.n, self.e + other.e).precision(p)

    def div(self, other):
        p = max(self.p, other.p)
        if not self.n:
            return Inf(0).precision(p)
        return Inf(quot(self.n * 10**p, other.n), self.e - other.e - p).precision(p)

    def pow(self, power):
        if power == 0:
            return Inf(1).precision(self.p)
        if not self.n or self.n * Decimal(10)**self.e == 1:
            return self
        result, base, remaining = Inf(1), self, abs(power)
        while remaining:
            if remaining % 2:
                result = result.mul(base)
            base = base.mul(base)
            remaining //= 2
        if power < 0:
            result = Inf(1).precision(self.p).div(result)
        return result.precision(self.p)

    def discard(self):
        return self if self.e >= 0 else self.at(0)

    def saved(self):
        if not self.n:
            return dict(digits='0', exponent=max(0, self.e), precision=self.p)
        digits = str(abs(self.n))
        trimmed = digits.rstrip('0')
        return dict(digits=('-' if self.n < 0 else '') + trimmed,
                    exponent=self.e + len(digits) - len(trimmed), precision=self.p)


def reward(stage, wave, percent, enhanced):
    if stage < 2:
        return Inf(0)
    p = stage * 5 + wave
    value = Inf(p).pow(2).mul(Inf.double(math.sqrt(p))).mul(Inf(percent)).div(Inf(100)).precision(5).precision(5)
    return value.mul(Inf(3)) if enhanced else value


def generate():
    source_paths = [
        'CatGunner-Original/Decompiled/native/Assembly-CSharp/Rebirth_manager__t7591.c',
        'CatGunner-Original/Decompiled/native/Assembly-CSharp/Cat__t7445.c',
        'CatGunner-Original/Decompiled/native/Assembly-CSharp/Gamemanager__t7191.c',
        'CatGunner-Original/Decompiled/native/Assembly-CSharp/Tree_manager__t7671.c',
        'CatGunner-Original/Decompiled/native/Assembly-CSharp/StarUpgrade_manager__t7549.c',
        'AI-Workspace/Work/cat-gunner/code-analysis/libil2cpp.so',
    ]
    fixture = dict(
        provenance=dict(version='Cat Gunner 1.1.61',
                        method='Independent Python integer-coefficient oracle, transcribed from ARM64 instructions and native manager operators; starting precision follows shipped scene tables recorded in original-economy-precision.json and original-stage-precision.json; not runtime captures.',
                        sourceSha256={path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in source_paths},
                        functions={'intConstructor': '0x4555b64 -> 0x4555028', 'doubleConstructor': '0x4556060',
                                   'precisionGetter': '0x4554ee0', 'toPrecision': '0x4558464', 'add': '0x4558020',
                                   'sub': '0x4558270', 'mul': '0x4558538', 'div': '0x45587e8',
                                   'discardDecimal': '0x455a16c', 'pow': '0x455ef6c'},
                        constants={'0x1070a18': format(1.6, '.17g'), '0x106fd58': format(1.002, '.17g'), '0x106fde8': format(1.05, '.17g')}),
        rewards=[], upgrades=[], combatDamage=[], treeMoney=[], stars=[])
    for stage in [0, 1, 2, 3, 19, 20, 99, 100, 999, 19999, 99999]:
        for wave in [0, 1, 4]:
            for percent in [100, 125]:
                fixture['rewards'].append(dict(stageIndex=stage, waveIndex=wave, rewardPercent=percent,
                                               ordinary=reward(stage, wave, percent, False).saved(),
                                               enhanced=reward(stage, wave, percent, True).saved()))
    levels = set([0, 1, 2, 3, 4, 5, 9, 10, 99, 100, 500, 999, 1000, 14999, 15000, 15001, 15002, 15003, 15005, 15010, 15100, 16000, 19000, 19998, 19999, 20000])
    factor = Inf(1)
    for level in range(20001):
        price = Inf.double(math.pow(level + 1, 1.6) * 3)
        if level > 15000:
            factor = factor.mul(Inf.double(1.002)).precision(4)
            price = price.mul(factor)
        price = price.discard().precision(3)
        if level in levels:
            bonus = Inf.double(1.05).pow(level).mul(Inf(100)).add(Inf(100), subtract=True).discard().precision(3)
            speed = Inf(5 * level).precision(5)
            fixture['upgrades'].append(dict(level=level, price=price.saved() if level < 20000 else None,
                                            powerBonus=bonus.saved(), powerPercent=bonus.add(Inf(100)).saved(),
                                            speedBonus=speed.saved(), speedPercent=speed.add(Inf(100)).saved(),
                                            latePriceFactor=factor.saved()))
    # Cat.Balance_Reload / Gamemanager.MoneyValue_return apply each percentage
    # through InfVal mul then div, including the intermediate truncations.
    ordinary = [Inf(10000, -2)]  # level0:124056 retains p5 at ordinary level zero.
    for level in range(10000):
        ordinary.append(ordinary[-1].mul(Inf.double(1.08)).precision(3))

    def rebirth_percent(level):
        return Inf.double(1.05).pow(level).mul(Inf(100)).add(Inf(100), subtract=True).discard().precision(3).add(Inf(100))

    stars, multiplier = [Inf(100)], 1.0
    for level in range(1, 21):
        multiplier = multiplier * math.pow(1.07, level - 1) * 1.5
        bonus = Inf.double((multiplier - 1.0) * 100).precision(2)
        stars.append(bonus.add(Inf(100)))
    for level, value in enumerate(stars):
        fixture['stars'].append(dict(level=level, percent=value.saved(), multiplier=value.div(Inf(100)).saved()))

    # Serialized Gun_manager coefficient/exponent is significant: 800e0 is p3.
    damage_cases = [(22, 800, 0, 5, 0), (22, 800, 0, 5, 1), (1, 80, 1, 1, 1),
                    (1, 80, 2, 11, 2), (0, 100, 5, 5, 10), (0, 100, 10, 11, 20),
                    (0, 100, 1000, 2000, 10), (22, 800, 10000, 20000, 20)]
    for weapon, base, level, rebirth_level, star in damage_cases:
        value = Inf(base).mul(ordinary[level]).div(Inf(100)).mul(rebirth_percent(rebirth_level)).div(Inf(100)).discard()
        if star:
            value = value.mul(stars[star]).div(Inf(100))
        fixture['combatDamage'].append(dict(weaponId=weapon, serializedBase=f'{base}e0',
            powerLevel=level, rebirthLevel=rebirth_level, starLevel=star, damage=value.saved()))

    money = [Inf(20000, -3)]  # level0:124872 retains p5 at stage zero.
    for stage in range(1, 5000):
        money.append(money[-1].mul(Inf(3)).precision(2))
    degree_multipliers = [Inf(1), Inf.double(1.8), Inf(3), Inf(100)]
    for stage, level, rebirth_level in [(0, 0, 5), (0, 1, 5), (1, 0, 11), (3, 1, 5), (10, 11, 11), (1000, 1000, 2000)]:
        for degree, factor in enumerate(degree_multipliers):
            base = money[stage].mul(factor)
            value = base.mul(ordinary[level]).div(Inf(100)).mul(rebirth_percent(rebirth_level)).div(Inf(100))
            fixture['treeMoney'].append(dict(stageIndex=stage, degree=degree, moneyLevel=level,
                rebirthLevel=rebirth_level, baseReward=base.saved(), payout=value.saved()))
    target = pathlib.Path(__file__).with_name('rebirth-golden.json')
    target.write_text(json.dumps(fixture, indent=2) + '\n', encoding='utf-8')
    print(f'Wrote {len(fixture["rewards"])} rewards, {len(fixture["upgrades"])} upgrades, '
          f'{len(fixture["combatDamage"])} damage, {len(fixture["treeMoney"])} money and {len(fixture["stars"])} star cases to {target}')


if __name__ == '__main__':
    generate()
