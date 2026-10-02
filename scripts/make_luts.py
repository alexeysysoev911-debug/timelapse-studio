# Собственные «образы» цветокоррекции Timelapse Studio (3D LUT 33³, формат .cube).
import numpy as np
N = 33
g = np.linspace(0, 1, N)
# порядок .cube: R меняется быстрее всего
b, gg, r = np.meshgrid(g, g, g, indexing="ij")
rgb = np.stack([r, gg, b], axis=-1).reshape(-1, 3)

def luma(c): return (c @ np.array([0.2126, 0.7152, 0.0722]))[:, None]
def sat(c, s): l = luma(c); return l + (c - l) * s
def scurve(c, k):  # мягкая S-кривая, k>0 — контраст
    return np.clip(c + k * np.sin(2 * np.pi * c) * -0.5 / np.pi * 0 + k * (c - 0.5) * (1 - np.abs(2 * c - 1)) , 0, 1)
def contrast(c, k): return np.clip((c - 0.5) * k + 0.5, 0, 1)
def lift(c, black, white=1.0): return black + c * (white - black)
def gamma(c, gm): return np.clip(c, 0, 1) ** gm
def tint(c, rgbmul): return c * np.array(rgbmul)
def split_tone(c, shadow, highlight, amount):
    l = luma(c)
    return c + amount * ((1 - l) * np.array(shadow) + l * np.array(highlight))
def smooth(c):  # гладкая S через smoothstep, смешанная
    return c * c * (3 - 2 * c)

looks = {
  "vivid":       lambda c: sat(contrast(c, 1.08), 1.32),
  "warm_film":   lambda c: sat(lift(tint(gamma(c, 0.97), [1.06, 1.0, 0.90]), 0.035, 0.98), 0.95),
  "cool_tech":   lambda c: sat(contrast(tint(c, [0.93, 1.0, 1.08]), 1.10), 1.05),
  "teal_orange": lambda c: sat(contrast(split_tone(c, [-0.05, 0.02, 0.07], [0.07, 0.015, -0.06], 1.0), 1.08), 1.12),
  "pastel":      lambda c: sat(lift(contrast(c, 0.86), 0.06, 0.99), 0.80) * np.array([1.02, 0.99, 1.02]),
  "golden_hour": lambda c: sat(tint(gamma(c, 0.95), [1.10, 1.02, 0.86]), 1.12),
  "matte":       lambda c: sat(lift(0.85 * smooth(c) + 0.15 * c, 0.08, 0.96), 0.88),
  "clean_bright":lambda c: sat(gamma(contrast(c, 1.04), 0.90), 1.08),
  "bw_contrast": lambda c: np.repeat(contrast(0.7 * smooth(luma(c)) + 0.3 * luma(c), 1.12), 3, axis=1),
}
for name, f in looks.items():
    out = np.clip(f(rgb.copy()), 0, 1)
    with open(f"{name}.cube", "w") as fh:
        fh.write(f'TITLE "Timelapse Studio {name}"\nLUT_3D_SIZE {N}\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n')
        for v in out:
            fh.write(f"{v[0]:.5f} {v[1]:.5f} {v[2]:.5f}\n")
    print(name, out.min(), out.max())
