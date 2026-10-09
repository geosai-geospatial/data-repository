// Dataset catalog. Each entry renders a card on the home page and a detail page
// at dataset.html?id=<id>.
//
// IMPORTANT: the entries below are EXAMPLES that show the expected structure.
// Replace every value (feature counts, years, sources, prices, attributes) with
// the real figures of the data you actually hold before publishing.
//
// Fields:
//   id          unique slug used in the URL
//   title       display name
//   category    used for the filter chips
//   summary     one or two sentences shown on the card
//   description longer text shown on the detail page (array of paragraphs)
//   coverage    geographic coverage, human readable
//   bbox        [west, south, east, north] in WGS84, drawn on the detail map
//   source      where the data originates
//   year        data vintage / last update
//   format      delivered file formats
//   crs         coordinate reference system
//   geometry    Polygon / Line / Point
//   features    number of features (number)
//   size        approximate download size
//   attributes  [{ name, type, description }]
//   price       display string, e.g. "Rp 750.000" or "Hubungi kami"
//   updated     ISO date of the last check of this listing

window.DATASETS = [
  {
    id: "iup-minerba-indonesia",
    title: "Wilayah IUP Mineral & Batubara Seluruh Indonesia",
    category: "Pertambangan",
    summary:
      "Poligon Wilayah Izin Usaha Pertambangan (IUP) mineral logam, batubara, mineral bukan logam, dan batuan, lengkap dengan status tahapan izin.",
    description: [
      "Dataset ini memuat batas wilayah Izin Usaha Pertambangan (IUP) Eksplorasi dan Operasi Produksi untuk komoditas mineral logam, batubara, mineral bukan logam, dan batuan di seluruh provinsi Indonesia.",
      "Setiap poligon dilengkapi nama pemegang izin, nomor SK, komoditas, tahapan kegiatan, luas, serta provinsi dan kabupaten. Geometri telah diperiksa topologinya (self-intersection dan duplikat) sebelum dikirim.",
    ],
    coverage: "Seluruh Indonesia (38 provinsi)",
    bbox: [95.0, -11.0, 141.0, 6.0],
    source: "Kompilasi dari publikasi resmi Kementerian ESDM (MODI / Geoportal ESDM)",
    year: "2025",
    format: ["SHP", "GeoPackage", "GeoJSON"],
    crs: "EPSG:4326 (WGS 84)",
    geometry: "Polygon",
    features: 0, // TODO: isi jumlah fitur sebenarnya
    size: "± 120 MB",
    attributes: [
      { name: "NAMA_USAHA", type: "Text", description: "Nama perusahaan pemegang izin" },
      { name: "NO_SK", type: "Text", description: "Nomor Surat Keputusan izin" },
      { name: "KOMODITAS", type: "Text", description: "Komoditas tambang (mis. Batubara, Nikel, Emas)" },
      { name: "TAHAPAN", type: "Text", description: "Eksplorasi / Operasi Produksi" },
      { name: "LUAS_HA", type: "Double", description: "Luas wilayah izin (hektar)" },
      { name: "PROVINSI", type: "Text", description: "Provinsi" },
      { name: "KABUPATEN", type: "Text", description: "Kabupaten / Kota" },
      { name: "TGL_BERLAKU", type: "Date", description: "Tanggal mulai berlaku izin" },
      { name: "TGL_AKHIR", type: "Date", description: "Tanggal berakhir izin" },
    ],
    price: "Hubungi kami",
    updated: "2026-10-01",
  },
  {
    id: "iuphhk-hti-indonesia",
    title: "Areal Kerja IUPHHK-HTI (PBPH Hutan Tanaman)",
    category: "Kehutanan",
    summary:
      "Batas areal kerja Izin Usaha Pemanfaatan Hasil Hutan Kayu pada Hutan Tanaman Industri (kini PBPH-HT) di seluruh Indonesia.",
    description: [
      "Poligon areal kerja IUPHHK-HTI / PBPH Hutan Tanaman beserta nama pemegang izin, nomor dan tanggal SK, serta luas sesuai SK.",
      "Cocok untuk analisis tumpang-tindih perizinan, uji tuntas (due diligence) rantai pasok kayu dan pulp, serta perencanaan proyek karbon dan restorasi.",
    ],
    coverage: "Seluruh Indonesia",
    bbox: [95.0, -11.0, 141.0, 6.0],
    source: "Kompilasi dari publikasi resmi KLHK / Kementerian Kehutanan (SIGAP / Geoportal)",
    year: "2025",
    format: ["SHP", "GeoPackage"],
    crs: "EPSG:4326 (WGS 84)",
    geometry: "Polygon",
    features: 0, // TODO: isi jumlah fitur sebenarnya
    size: "± 45 MB",
    attributes: [
      { name: "NAMA_PT", type: "Text", description: "Nama perusahaan pemegang izin" },
      { name: "NO_SK", type: "Text", description: "Nomor SK izin" },
      { name: "TGL_SK", type: "Date", description: "Tanggal SK" },
      { name: "LUAS_SK", type: "Double", description: "Luas menurut SK (hektar)" },
      { name: "PROVINSI", type: "Text", description: "Provinsi" },
      { name: "STATUS", type: "Text", description: "Status izin (aktif / dicabut)" },
    ],
    price: "Hubungi kami",
    updated: "2026-10-01",
  },
  {
    id: "iuphhk-ha-indonesia",
    title: "Areal Kerja IUPHHK-HA (PBPH Hutan Alam)",
    category: "Kehutanan",
    summary:
      "Batas areal konsesi hutan alam (HPH / IUPHHK-HA / PBPH-HA) dengan atribut pemegang izin dan luas SK.",
    description: [
      "Poligon areal kerja IUPHHK-HA / PBPH Hutan Alam di seluruh Indonesia beserta informasi pemegang izin dan legalitasnya.",
    ],
    coverage: "Seluruh Indonesia",
    bbox: [95.0, -11.0, 141.0, 6.0],
    source: "Kompilasi dari publikasi resmi KLHK / Kementerian Kehutanan",
    year: "2025",
    format: ["SHP", "GeoPackage"],
    crs: "EPSG:4326 (WGS 84)",
    geometry: "Polygon",
    features: 0, // TODO
    size: "± 40 MB",
    attributes: [
      { name: "NAMA_PT", type: "Text", description: "Nama perusahaan pemegang izin" },
      { name: "NO_SK", type: "Text", description: "Nomor SK izin" },
      { name: "LUAS_SK", type: "Double", description: "Luas menurut SK (hektar)" },
      { name: "PROVINSI", type: "Text", description: "Provinsi" },
    ],
    price: "Hubungi kami",
    updated: "2026-10-01",
  },
  {
    id: "kawasan-hutan-indonesia",
    title: "Kawasan Hutan & Fungsi Kawasan Indonesia",
    category: "Kehutanan",
    summary:
      "Fungsi kawasan hutan (HK, HL, HPT, HP, HPK) dan Areal Penggunaan Lain (APL) per provinsi.",
    description: [
      "Poligon fungsi kawasan hutan berdasarkan SK penetapan / penunjukan kawasan hutan terbaru per provinsi, termasuk APL.",
    ],
    coverage: "Seluruh Indonesia",
    bbox: [95.0, -11.0, 141.0, 6.0],
    source: "Kompilasi dari publikasi resmi KLHK / Kementerian Kehutanan",
    year: "2024",
    format: ["SHP", "GeoPackage"],
    crs: "EPSG:4326 (WGS 84)",
    geometry: "Polygon",
    features: 0, // TODO
    size: "± 300 MB",
    attributes: [
      { name: "FUNGSI", type: "Text", description: "Kode fungsi kawasan (HK, HL, HPT, HP, HPK, APL)" },
      { name: "SK_KAWASAN", type: "Text", description: "Dasar hukum (SK kawasan hutan)" },
      { name: "PROVINSI", type: "Text", description: "Provinsi" },
      { name: "LUAS_HA", type: "Double", description: "Luas (hektar)" },
    ],
    price: "Hubungi kami",
    updated: "2026-10-01",
  },
  {
    id: "hgu-perkebunan-sawit",
    title: "Konsesi Perkebunan Kelapa Sawit",
    category: "Perkebunan",
    summary:
      "Poligon konsesi perkebunan kelapa sawit (HGU / IUP-Perkebunan) dengan nama perusahaan dan grup induk.",
    description: [
      "Batas konsesi perkebunan kelapa sawit hasil kompilasi berbagai sumber publik, dinormalisasi ke satu skema atribut dan diberi informasi grup perusahaan bila tersedia.",
    ],
    coverage: "Sumatra, Kalimantan, Sulawesi, Papua",
    bbox: [95.0, -9.0, 141.0, 6.0],
    source: "Kompilasi dari sumber publik (ATR/BPN, Dinas Perkebunan, dan laporan perusahaan)",
    year: "2024",
    format: ["SHP", "GeoPackage"],
    crs: "EPSG:4326 (WGS 84)",
    geometry: "Polygon",
    features: 0, // TODO
    size: "± 60 MB",
    attributes: [
      { name: "NAMA_PT", type: "Text", description: "Nama perusahaan" },
      { name: "GRUP", type: "Text", description: "Grup induk perusahaan" },
      { name: "JENIS_IZIN", type: "Text", description: "HGU / IUP-B / Izin Lokasi" },
      { name: "LUAS_HA", type: "Double", description: "Luas (hektar)" },
      { name: "PROVINSI", type: "Text", description: "Provinsi" },
    ],
    price: "Hubungi kami",
    updated: "2026-10-01",
  },
  {
    id: "batas-administrasi-desa",
    title: "Batas Administrasi hingga Desa / Kelurahan",
    category: "Administrasi",
    summary:
      "Batas wilayah provinsi, kabupaten/kota, kecamatan, dan desa/kelurahan dengan kode wilayah Kemendagri.",
    description: [
      "Batas administrasi berjenjang dalam satu GeoPackage multi-layer, dilengkapi kode wilayah Kemendagri sehingga mudah di-join dengan data statistik BPS.",
    ],
    coverage: "Seluruh Indonesia",
    bbox: [95.0, -11.0, 141.0, 6.0],
    source: "Kompilasi dari publikasi resmi BIG (RBI) dan Kemendagri",
    year: "2024",
    format: ["SHP", "GeoPackage"],
    crs: "EPSG:4326 (WGS 84)",
    geometry: "Polygon",
    features: 0, // TODO
    size: "± 500 MB",
    attributes: [
      { name: "KODE_WIL", type: "Text", description: "Kode wilayah Kemendagri" },
      { name: "NAMA_DESA", type: "Text", description: "Nama desa / kelurahan" },
      { name: "KECAMATAN", type: "Text", description: "Kecamatan" },
      { name: "KABUPATEN", type: "Text", description: "Kabupaten / Kota" },
      { name: "PROVINSI", type: "Text", description: "Provinsi" },
    ],
    price: "Hubungi kami",
    updated: "2026-10-01",
  },
];
