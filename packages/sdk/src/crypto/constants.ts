export const BJJ_SUBGROUP_ORDER =
  2736030358979909402780800718157159386076813972158567259200215660948447373041n;

/** Note-cipher keystream domain tag (keccak256("kakure.enc.v1") % BN254_Fr). Must match Noir `ENC_DOMAIN`. */
export const ENC_DOMAIN =
  0x23f955e41a1c10e85986f4fb49fcaf4cb8a6d3264f10fd0253d5e212303b9882n;

/** Leaf-blinder (psi) domain tag (keccak256("kakure.psi.v1") % BN254_Fr). Must match Noir `PSI_DOMAIN`. */
export const PSI_DOMAIN =
  0x20b80b02c7b72d50c3f3dbdb4aa38592cdac5c1aa0f9d3f3509480ae234a790n;
