/**
 * The 23 special wards of Tokyo.
 *
 * `code` is the JIS municipality code, which is what PLATEAU's data catalog keys
 * datasets by. `center` and `radiusKm` are approximate and used only to decide which
 * wards are near the camera, so that a phone never downloads all 23 at once.
 */
export const TOKYO_WARDS = [
  { code: "13101", name: "千代田区", nameEn: "Chiyoda",   center: [139.7536, 35.6940], radiusKm: 3.0 },
  { code: "13102", name: "中央区",   nameEn: "Chuo",      center: [139.7723, 35.6706], radiusKm: 3.0 },
  { code: "13103", name: "港区",     nameEn: "Minato",    center: [139.7514, 35.6581], radiusKm: 4.0 },
  { code: "13104", name: "新宿区",   nameEn: "Shinjuku",  center: [139.7036, 35.6938], radiusKm: 3.5 },
  { code: "13105", name: "文京区",   nameEn: "Bunkyo",    center: [139.7522, 35.7181], radiusKm: 3.0 },
  { code: "13106", name: "台東区",   nameEn: "Taito",     center: [139.7800, 35.7126], radiusKm: 2.8 },
  { code: "13107", name: "墨田区",   nameEn: "Sumida",    center: [139.8016, 35.7107], radiusKm: 3.2 },
  { code: "13108", name: "江東区",   nameEn: "Koto",      center: [139.8175, 35.6730], radiusKm: 5.0 },
  { code: "13109", name: "品川区",   nameEn: "Shinagawa", center: [139.7301, 35.6092], radiusKm: 3.8 },
  { code: "13110", name: "目黒区",   nameEn: "Meguro",    center: [139.6982, 35.6415], radiusKm: 3.2 },
  { code: "13111", name: "大田区",   nameEn: "Ota",       center: [139.7161, 35.5614], radiusKm: 6.5 },
  { code: "13112", name: "世田谷区", nameEn: "Setagaya",  center: [139.6533, 35.6465], radiusKm: 5.5 },
  { code: "13113", name: "渋谷区",   nameEn: "Shibuya",   center: [139.6980, 35.6640], radiusKm: 3.2 },
  { code: "13114", name: "中野区",   nameEn: "Nakano",    center: [139.6637, 35.7074], radiusKm: 2.8 },
  { code: "13115", name: "杉並区",   nameEn: "Suginami",  center: [139.6363, 35.6994], radiusKm: 4.5 },
  { code: "13116", name: "豊島区",   nameEn: "Toshima",   center: [139.7160, 35.7360], radiusKm: 2.8 },
  { code: "13117", name: "北区",     nameEn: "Kita",      center: [139.7336, 35.7528], radiusKm: 4.0 },
  { code: "13118", name: "荒川区",   nameEn: "Arakawa",   center: [139.7833, 35.7361], radiusKm: 2.6 },
  { code: "13119", name: "板橋区",   nameEn: "Itabashi",  center: [139.7093, 35.7512], radiusKm: 4.5 },
  { code: "13120", name: "練馬区",   nameEn: "Nerima",    center: [139.6517, 35.7356], radiusKm: 5.0 },
  { code: "13121", name: "足立区",   nameEn: "Adachi",    center: [139.8045, 35.7750], radiusKm: 5.5 },
  { code: "13122", name: "葛飾区",   nameEn: "Katsushika",center: [139.8474, 35.7434], radiusKm: 4.5 },
  { code: "13123", name: "江戸川区", nameEn: "Edogawa",   center: [139.8683, 35.7067], radiusKm: 5.5 },
];

export const TOKYO_WARD_CODES = TOKYO_WARDS.map((w) => w.code);
