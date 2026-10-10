// GeoTIFF reader and band styling for the public viewer (lihat-geotiff.html).
// Runs in the browser and in Node (tests). The file is read in pieces
// (Blob.slice) as needed, so a large GeoTIFF never has to fit in memory: only
// the tiles or strips that the display grid samples are read and decoded.
//
// Supported: classic TIFF and BigTIFF, either byte order; strips or tiles;
// chunky or planar bands; 8/16/32/64-bit unsigned, signed and float samples;
// no compression, LZW, Deflate and PackBits with horizontal or floating-point
// predictors; JPEG and WebP through the browser's image decoder; overviews
// (COG); GDAL nodata, alpha, palette, band descriptions. Georeferencing from
// tie point + pixel scale or a model transformation; coordinates in
// geographic (WGS 84 and similar), Web Mercator, UTM (WGS 84 or DGN95),
// Indonesia TM-3 or any user-defined Transverse Mercator in metres.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./staticmap"));
  else root.GeoTiff = factory(root.StaticMap);
})(this, function (SM) {
  "use strict";

  function fail(msg) { throw new Error(msg); }

  // Display grid limits: at most 2048 pixels a side and 32 million values in
  // all bands together (128 MB of Float32), whatever the size of the file.
  var MAX_SIDE = 2048, MAX_VALUES = 32 * 1024 * 1024;

  // ---------- Sources ----------
  function blobSource(blob) {
    return {
      size: blob.size,
      read: function (off, len) {
        return blob.slice(off, off + len).arrayBuffer().then(function (b) { return new Uint8Array(b); });
      },
    };
  }
  function bytesSource(u8) {
    return {
      size: u8.length,
      read: function (off, len) { return Promise.resolve(u8.subarray(off, off + len)); },
    };
  }

  // ---------- TIFF structure ----------
  var TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8, 17: 8, 18: 8 };
  var TAG = {
    NewSubfileType: 254, ImageWidth: 256, ImageLength: 257, BitsPerSample: 258, Compression: 259,
    Photometric: 262, StripOffsets: 273, SamplesPerPixel: 277, RowsPerStrip: 278, StripByteCounts: 279,
    PlanarConfiguration: 284, Predictor: 317, ColorMap: 320, TileWidth: 322, TileLength: 323,
    TileOffsets: 324, TileByteCounts: 325, ExtraSamples: 338, SampleFormat: 339, JPEGTables: 347,
    ModelPixelScale: 33550, ModelTiepoint: 33922, ModelTransformation: 34264,
    GeoKeyDirectory: 34735, GeoDoubleParams: 34736, GeoAsciiParams: 34737,
    GdalMetadata: 42112, GdalNodata: 42113,
  };

  function readValues(dv, off, type, count, le) {
    var out = [], size = TYPE_SIZE[type], i;
    if (type === 2) {
      var s = "";
      for (i = 0; i < count; i++) s += String.fromCharCode(dv.getUint8(off + i));
      return s.replace(/\0+$/, "");
    }
    for (i = 0; i < count; i++) {
      var p = off + i * size;
      switch (type) {
        case 1: case 7: out.push(dv.getUint8(p)); break;
        case 6: out.push(dv.getInt8(p)); break;
        case 3: out.push(dv.getUint16(p, le)); break;
        case 8: out.push(dv.getInt16(p, le)); break;
        case 4: case 13: out.push(dv.getUint32(p, le)); break;
        case 9: out.push(dv.getInt32(p, le)); break;
        case 5: out.push(dv.getUint32(p, le) / dv.getUint32(p + 4, le)); break;
        case 10: out.push(dv.getInt32(p, le) / dv.getInt32(p + 4, le)); break;
        case 11: out.push(dv.getFloat32(p, le)); break;
        case 12: out.push(dv.getFloat64(p, le)); break;
        case 16: case 18: out.push(Number(dv.getBigUint64(p, le))); break;
        case 17: out.push(Number(dv.getBigInt64(p, le))); break;
        default: out.push(0);
      }
    }
    return out;
  }

  function readHeader(src) {
    return src.read(0, 16).then(function (b) {
      if (b.length < 8) fail("not a TIFF");
      var bom = String.fromCharCode(b[0], b[1]);
      if (bom !== "II" && bom !== "MM") fail("not a TIFF");
      var le = bom === "II", dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      var magic = dv.getUint16(2, le);
      if (magic === 42) return { le: le, big: false, first: dv.getUint32(4, le) };
      if (magic === 43) return { le: le, big: true, first: Number(dv.getBigUint64(8, le)) };
      fail("not a TIFF");
    });
  }

  // Reads one IFD: { tags: {tag: value[]|string}, next }.
  function readIfd(src, head, offset) {
    var entrySize = head.big ? 20 : 12, countSize = head.big ? 8 : 2;
    return src.read(offset, countSize).then(function (b) {
      var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      var n = head.big ? Number(dv.getBigUint64(0, head.le)) : dv.getUint16(0, head.le);
      if (n > 4096) fail("broken TIFF directory");
      return src.read(offset + countSize, n * entrySize + (head.big ? 8 : 4)).then(function (e) {
        var dv = new DataView(e.buffer, e.byteOffset, e.byteLength);
        var tags = {}, far = [];
        for (var i = 0; i < n; i++) {
          var p = i * entrySize;
          var tag = dv.getUint16(p, head.le), type = dv.getUint16(p + 2, head.le);
          var count = head.big ? Number(dv.getBigUint64(p + 4, head.le)) : dv.getUint32(p + 4, head.le);
          var size = (TYPE_SIZE[type] || 0) * count, valueAt = p + (head.big ? 12 : 8);
          if (!TYPE_SIZE[type]) continue;
          if (size <= (head.big ? 8 : 4)) tags[tag] = readValues(dv, valueAt, type, count, head.le);
          else far.push({ tag: tag, type: type, count: count, size: size,
            at: head.big ? Number(dv.getBigUint64(valueAt, head.le)) : dv.getUint32(valueAt, head.le) });
        }
        var nextAt = n * entrySize;
        var next = head.big ? Number(dv.getBigUint64(nextAt, head.le)) : dv.getUint32(nextAt, head.le);
        return Promise.all(far.map(function (f) {
          // JPEG tables are opaque bytes; keep them as one array.
          return src.read(f.at, f.size).then(function (v) {
            if (f.tag === TAG.JPEGTables) { tags[f.tag] = v.slice(); return; }
            tags[f.tag] = readValues(new DataView(v.buffer, v.byteOffset, v.byteLength), 0, f.type, f.count, head.le);
          });
        })).then(function () { return { tags: tags, next: next }; });
      });
    });
  }

  function readIfds(src) {
    return readHeader(src).then(function (head) {
      var ifds = [], seen = {};
      function next(offset) {
        if (!offset || seen[offset] || ifds.length >= 64 || offset >= src.size) return { head: head, ifds: ifds };
        seen[offset] = true;
        return readIfd(src, head, offset).then(function (r) { ifds.push(r.tags); return next(r.next); });
      }
      return next(head.first);
    });
  }

  function one(tags, tag, dflt) { var v = tags[tag]; return v == null ? dflt : Array.isArray(v) ? v[0] : v; }

  // ---------- Image description ----------
  function describe(tags) {
    var spp = one(tags, TAG.SamplesPerPixel, 1);
    var bits = tags[TAG.BitsPerSample] || [1];
    var formats = tags[TAG.SampleFormat] || [1];
    var tiled = tags[TAG.TileWidth] != null;
    var img = {
      width: one(tags, TAG.ImageWidth, 0),
      height: one(tags, TAG.ImageLength, 0),
      spp: spp,
      bits: bits[0],
      format: formats[0],
      compression: one(tags, TAG.Compression, 1),
      photometric: one(tags, TAG.Photometric, 1),
      planar: one(tags, TAG.PlanarConfiguration, 1),
      predictor: one(tags, TAG.Predictor, 1),
      subfile: one(tags, TAG.NewSubfileType, 0),
      tiled: tiled,
      offsets: (tiled ? tags[TAG.TileOffsets] : tags[TAG.StripOffsets]) || [],
      counts: (tiled ? tags[TAG.TileByteCounts] : tags[TAG.StripByteCounts]) || [],
      jpegTables: tags[TAG.JPEGTables] || null,
      colormap: tags[TAG.ColorMap] || null,
      extra: tags[TAG.ExtraSamples] || [],
    };
    img.tileW = tiled ? one(tags, TAG.TileWidth) : img.width;
    img.tileH = tiled ? one(tags, TAG.TileLength) : Math.min(one(tags, TAG.RowsPerStrip, img.height), img.height) || img.height;
    if (spp === 1) img.planar = 1;
    img.across = Math.ceil(img.width / img.tileW);
    img.down = Math.ceil(img.height / img.tileH);
    return img;
  }

  var COMPRESSION = { 1: "none", 5: "LZW", 7: "JPEG", 8: "Deflate", 32946: "Deflate", 32773: "PackBits", 50001: "WebP" };
  var COMPRESSION_NAME = { 6: "old JPEG", 34887: "LERC", 34925: "LZMA", 50000: "ZSTD", 34712: "JPEG 2000" };

  function checkSupported(img) {
    if (!img.width || !img.height) fail("broken TIFF: no image size");
    if (!COMPRESSION[img.compression]) {
      fail("compression " + (COMPRESSION_NAME[img.compression] || img.compression) + " is not supported");
    }
    var browserCodec = img.compression === 7 || img.compression === 50001;
    if (browserCodec) {
      if (img.bits !== 8 || img.planar !== 1 || (img.spp !== 1 && img.spp !== 3 && img.spp !== 4)) fail("unsupported JPEG/WebP layout");
    } else if ([8, 16, 32, 64].indexOf(img.bits) < 0) {
      fail(img.bits + "-bit samples are not supported");
    }
    if (img.format === 3 && img.bits < 32) fail("16-bit float samples are not supported");
    if (img.format > 3) fail("complex samples are not supported");
    var n = img.planar === 2 ? img.across * img.down * img.spp : img.across * img.down;
    if (img.offsets.length < n || img.counts.length < n) fail("broken TIFF: missing tile offsets");
  }

  // ---------- Georeferencing ----------
  // Geotransform in GDAL order: x = t[0] + col*t[1] + row*t[2], y = t[3] + col*t[4] + row*t[5]
  // (col/row at the pixel's top-left corner).
  function geotransform(tags) {
    var m = tags[TAG.ModelTransformation];
    if (m && m.length >= 16) return [m[3], m[0], m[1], m[7], m[4], m[5]];
    var tp = tags[TAG.ModelTiepoint], sc = tags[TAG.ModelPixelScale];
    if (tp && tp.length >= 6 && sc && sc.length >= 2) {
      return [tp[3] - tp[0] * sc[0], sc[0], 0, tp[4] + tp[1] * sc[1], 0, -sc[1]];
    }
    return null;
  }

  function geoKeys(tags) {
    var dir = tags[TAG.GeoKeyDirectory], keys = {};
    if (!dir || dir.length < 4) return keys;
    var doubles = tags[TAG.GeoDoubleParams] || [], ascii = tags[TAG.GeoAsciiParams] || "";
    for (var i = 0; i < dir[3]; i++) {
      var p = 4 + i * 4, id = dir[p], loc = dir[p + 1], count = dir[p + 2], v = dir[p + 3];
      if (loc === 0) keys[id] = v;
      else if (loc === TAG.GeoDoubleParams) keys[id] = count === 1 ? doubles[v] : doubles.slice(v, v + count);
      else if (loc === TAG.GeoAsciiParams) keys[id] = ascii.substr(v, count).replace(/[|\0]+$/, "");
    }
    return keys;
  }

  // ---------- Coordinate reference systems ----------
  var A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F), EP2 = E2 / (1 - E2), DEG = Math.PI / 180;

  function meridianArc(phi) {
    return A * ((1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 * E2 * E2 / 256) * phi -
      (3 * E2 / 8 + 3 * E2 * E2 / 32 + 45 * E2 * E2 * E2 / 1024) * Math.sin(2 * phi) +
      (15 * E2 * E2 / 256 + 45 * E2 * E2 * E2 / 1024) * Math.sin(4 * phi) -
      (35 * E2 * E2 * E2 / 3072) * Math.sin(6 * phi));
  }
  // Forward Transverse Mercator (Snyder, USGS PP 1395, eq. 8-9 to 8-10);
  // the inverse is staticmap.js's tmInverse.
  function tmForward(p) {
    var m0 = meridianArc(p.lat0 * DEG);
    return function (lon, lat) {
      var phi = lat * DEG, s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi);
      var n = A / Math.sqrt(1 - E2 * s * s), t1 = t * t, c1 = EP2 * c * c;
      var a = (lon - p.lon0) * DEG * c, m = meridianArc(phi);
      var x = p.k0 * n * (a + (1 - t1 + c1) * Math.pow(a, 3) / 6 + (5 - 18 * t1 + t1 * t1 + 72 * c1 - 58 * EP2) * Math.pow(a, 5) / 120);
      var y = p.k0 * (m - m0 + n * t * (a * a / 2 + (5 - t1 + 9 * c1 + 4 * c1 * c1) * Math.pow(a, 4) / 24 +
        (61 - 58 * t1 + t1 * t1 + 600 * c1 - 330 * EP2) * Math.pow(a, 6) / 720));
      return [x + p.fe, y + p.fn];
    };
  }
  function tm(name, p) { return { name: name, toLonLat: SM.tmInverse(p), fromLonLat: tmForward(p) }; }
  function utmParams(zone, south) { return { lon0: zone * 6 - 183, lat0: 0, k0: 0.9996, fe: 500000, fn: south ? 10000000 : 0 }; }
  var TM3_ZONES = ["46.2", "47.1", "47.2", "48.1", "48.2", "49.1", "49.2", "50.1", "50.2", "51.1", "51.2", "52.1", "52.2", "53.1", "53.2", "54.1"];

  var GEOGRAPHIC = { name: "WGS 84 (bujur/lintang)", toLonLat: function (x, y) { return [x, y]; }, fromLonLat: function (lon, lat) { return [lon, lat]; } };
  var MERCATOR = {
    name: "WGS 84 / Pseudo-Mercator",
    toLonLat: function (x, y) { return [x / A / DEG, (2 * Math.atan(Math.exp(y / A)) - Math.PI / 2) / DEG]; },
    fromLonLat: function (lon, lat) { return [lon * DEG * A, A * Math.log(Math.tan(Math.PI / 4 + lat * DEG / 2))]; },
  };

  // EPSG code of a projected CRS → { name, toLonLat, fromLonLat }. Datum
  // shifts (DGN95 vs WGS 84, under 2 m) are ignored, as in staticmap.js.
  function epsg(code) {
    if (code === 3857 || code === 900913 || code === 3785 || code === 102100) return MERCATOR;
    if (code > 32600 && code <= 32660) return tm("WGS 84 / UTM " + (code - 32600) + "N", utmParams(code - 32600, false));
    if (code > 32700 && code <= 32760) return tm("WGS 84 / UTM " + (code - 32700) + "S", utmParams(code - 32700, true));
    if (code >= 23866 && code <= 23872) return tm("DGN95 / UTM " + (code - 23820) + "N", utmParams(code - 23820, false));
    if (code >= 23877 && code <= 23884) return tm("DGN95 / UTM " + (code - 23830) + "S", utmParams(code - 23830, true));
    if (code >= 23830 && code <= 23845) {
      return tm("DGN95 / Indonesia TM-3 " + TM3_ZONES[code - 23830], { lon0: 94.5 + 3 * (code - 23830), lat0: 0, k0: 0.9999, fe: 200000, fn: 1500000 });
    }
    return null;
  }

  // GeoKeys → CRS. Geographic CRSs of any datum are treated as WGS 84.
  function crsOf(keys) {
    var model = keys[1024];
    if (model === 2) return GEOGRAPHIC;
    if (model !== 1 && model !== undefined) fail("unsupported CRS model");
    var code = keys[3072];
    if (code === undefined && model === undefined) return null;
    if (code && code !== 32767) {
      var c = epsg(code);
      if (c) return c;
      fail("projection EPSG:" + code + " is not supported");
    }
    var units = keys[3076];
    if (units !== undefined && units !== 9001) fail("projection units are not metres");
    var proj = keys[3074];
    if (proj > 16000 && proj <= 16060) return tm("UTM " + (proj - 16000) + "N", utmParams(proj - 16000, false));
    if (proj > 16100 && proj <= 16160) return tm("UTM " + (proj - 16100) + "S", utmParams(proj - 16100, true));
    if (keys[3075] === 1) {
      var name = typeof keys[3073] === "string" && keys[3073] ? keys[3073] : "Transverse Mercator";
      return tm(name, {
        lon0: keys[3088] != null ? keys[3088] : keys[3080] || 0,
        lat0: keys[3089] != null ? keys[3089] : keys[3081] || 0,
        k0: keys[3092] != null ? keys[3092] : 1,
        fe: keys[3082] || 0,
        fn: keys[3083] || 0,
      });
    }
    if (keys[3075] === 7) return MERCATOR;
    fail("projection " + (keys[3073] || code || "") + " is not supported");
  }

  // ---------- GDAL extras ----------
  function bandNames(xml, n) {
    var names = [], m, re = /<Item\s+([^>]*)>([^<]*)<\/Item>/g;
    while ((m = re.exec(xml || ""))) {
      var attrs = m[1];
      if (!/name="DESCRIPTION"/.test(attrs) || !/role="description"/.test(attrs)) continue;
      var s = Number((attrs.match(/sample="(\d+)"/) || [])[1]);
      if (s >= 0 && s < n) names[s] = m[2].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();
    }
    return names;
  }

  // ---------- Decompression ----------
  function inflate(bytes) {
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  // TIFF LZW: MSB-first codes, 9 to 12 bits, code width grows one code early.
  function lzw(input, expected) {
    var out = new Uint8Array(expected), op = 0;
    var prefix = new Int32Array(4096), suffix = new Uint8Array(4096), lengths = new Int32Array(4096);
    var first = new Uint8Array(4096), stack = new Uint8Array(4096);
    for (var i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; lengths[i] = 1; first[i] = i; }
    var next = 258, width = 9, bitPos = 0, total = input.length * 8, prev = -1;
    while (bitPos + width <= total && op < expected) {
      var code = 0, need = width, bp = bitPos;
      while (need > 0) {
        var byte = input[bp >> 3], avail = 8 - (bp & 7), take = Math.min(avail, need);
        code = (code << take) | ((byte >> (avail - take)) & ((1 << take) - 1));
        bp += take; need -= take;
      }
      bitPos += width;
      if (code === 256) { next = 258; width = 9; prev = -1; continue; }
      if (code === 257) break;
      var entry;
      if (code < next && (code < 256 || code >= 258)) entry = code;
      else if (code === next && prev >= 0) entry = -1;
      else break; // corrupt stream
      if (prev >= 0 && next < 4096) {
        prefix[next] = prev;
        suffix[next] = entry === -1 ? first[prev] : first[entry];
        lengths[next] = lengths[prev] + 1;
        first[next] = first[prev];
        next++;
        if (entry === -1) entry = next - 1;
      }
      // Write the string for `entry`, last byte first.
      var len = lengths[entry], c = entry, sp = len;
      while (c >= 0 && sp > 0) { stack[--sp] = suffix[c]; c = prefix[c]; }
      for (var k = 0; k < len && op < expected; k++) out[op++] = stack[k];
      prev = entry;
      if (next + 1 >= (1 << width) && width < 12) width++;
    }
    return out;
  }

  function packbits(input, expected) {
    var out = new Uint8Array(expected), ip = 0, op = 0;
    while (ip < input.length && op < expected) {
      var n = input[ip++];
      if (n < 128) { for (var i = 0; i <= n && op < expected; i++) out[op++] = input[ip++]; }
      else if (n > 128) { var v = input[ip++]; for (var j = 0; j < 257 - n && op < expected; j++) out[op++] = v; }
    }
    return out;
  }

  function decompress(img, bytes, expected) {
    switch (img.compression) {
      case 1: return Promise.resolve(bytes);
      case 5: return Promise.resolve(lzw(bytes, expected));
      case 8: case 32946: return inflate(bytes);
      case 32773: return Promise.resolve(packbits(bytes, expected));
    }
    return Promise.reject(new Error("compression " + img.compression + " is not supported"));
  }

  // ---------- Samples ----------
  var ARRAYS = {
    "1/8": Uint8Array, "1/16": Uint16Array, "1/32": Uint32Array, "1/64": BigUint64Array,
    "2/8": Int8Array, "2/16": Int16Array, "2/32": Int32Array, "2/64": BigInt64Array,
    "3/32": Float32Array, "3/64": Float64Array,
  };
  var LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

  // Decoded chunk bytes → typed array in this machine's byte order, with the
  // predictor undone. `rowLen` is the number of samples per chunk row.
  function samples(img, bytes, rowLen, rows) {
    var size = img.bits / 8, n = rowLen * rows, T = ARRAYS[img.format + "/" + img.bits] || ARRAYS["1/" + img.bits];
    var buf = new Uint8Array(n * size);
    buf.set(bytes.subarray(0, Math.min(bytes.length, buf.length)));
    var stride = img.planar === 2 ? 1 : img.spp, r, i;
    if (img.predictor === 3) {
      // Floating-point predictor: bytes are differenced across the row, then
      // stored most significant byte first, one plane per byte position.
      var rowBytes = rowLen * size, tmp = new Uint8Array(rowBytes);
      for (r = 0; r < rows; r++) {
        var row = buf.subarray(r * rowBytes, (r + 1) * rowBytes);
        for (i = stride; i < rowBytes; i++) row[i] = (row[i] + row[i - stride]) & 255;
        tmp.set(row);
        for (i = 0; i < rowLen; i++) {
          for (var b = 0; b < size; b++) row[i * size + (LITTLE ? size - 1 - b : b)] = tmp[b * rowLen + i];
        }
      }
      return new T(buf.buffer);
    }
    if (size > 1 && (img.le !== LITTLE)) {
      for (i = 0; i < buf.length; i += size) {
        for (var lo = i, hi = i + size - 1; lo < hi; lo++, hi--) { var t = buf[lo]; buf[lo] = buf[hi]; buf[hi] = t; }
      }
    }
    var a = new T(buf.buffer);
    if (img.predictor === 2) {
      for (r = 0; r < rows; r++) {
        var start = r * rowLen;
        for (i = start + stride; i < start + rowLen; i++) a[i] += a[i - stride];
      }
    }
    return a;
  }

  // JPEG/WebP tiles: the browser decodes them. `decodeImage` is injectable
  // for tests; it gets the full image bytes and returns RGBA pixels.
  function browserDecodeImage(bytes, type, w, h) {
    if (typeof createImageBitmap !== "function") return Promise.reject(new Error("image decoder not available"));
    return createImageBitmap(new Blob([bytes], { type: type })).then(function (bmp) {
      var canvas = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(w, h) : document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      return ctx.getImageData(0, 0, w, h).data;
    });
  }
  function jpegBytes(img, bytes) {
    var t = img.jpegTables;
    if (!t || t.length < 4) return bytes;
    // Tables (minus their EOI) + tile (minus its SOI).
    var out = new Uint8Array(t.length - 2 + bytes.length - 2);
    out.set(t.subarray(0, t.length - 2), 0);
    out.set(bytes.subarray(2), t.length - 2);
    return out;
  }
  function decodeBrowserChunk(img, bytes, w, h, decodeImage) {
    var jpeg = img.compression === 7;
    return (decodeImage || browserDecodeImage)(jpeg ? jpegBytes(img, bytes) : bytes, jpeg ? "image/jpeg" : "image/webp", w, h).then(function (rgba) {
      var spp = img.spp, out = new Uint8Array(w * h * spp);
      for (var i = 0; i < w * h; i++) {
        if (spp === 1) out[i] = rgba[i * 4];
        else for (var s = 0; s < spp; s++) out[i * spp + s] = rgba[i * 4 + s];
      }
      return out;
    });
  }

  // ---------- Reading ----------
  // Opens a GeoTIFF: reads the directories only. `source` is a Blob/File or a
  // Uint8Array.
  function open(source) {
    var src = source instanceof Uint8Array ? bytesSource(source) : blobSource(source);
    return readIfds(src).then(function (r) {
      if (!r.ifds.length) fail("not a TIFF");
      var main = describe(r.ifds[0]);
      main.le = r.head.le;
      checkSupported(main);
      var t = geotransform(r.ifds[0]);
      if (!t) fail("not georeferenced");
      var crs = crsOf(geoKeys(r.ifds[0]));
      if (!crs) {
        // No GeoKeys: assume longitude/latitude when the numbers fit.
        if (Math.abs(t[0]) <= 360 && Math.abs(t[3]) <= 90) crs = GEOGRAPHIC;
        else fail("not georeferenced");
      }
      // Overviews: reduced-resolution images with the same bands.
      var levels = [main];
      r.ifds.slice(1).forEach(function (tags) {
        var o = describe(tags);
        o.le = r.head.le;
        if (!(o.subfile & 1) || (o.subfile & 4) || o.spp !== main.spp || o.bits !== main.bits || o.format !== main.format) return;
        try { checkSupported(o); levels.push(o); } catch (e) { /* skip an overview we cannot read */ }
      });
      levels.sort(function (a, b) { return b.width - a.width; });

      var alpha = -1;
      main.extra.forEach(function (kind, i) { if ((kind === 1 || kind === 2) && alpha < 0) alpha = main.spp - main.extra.length + i; });
      var nodataText = r.ifds[0][TAG.GdalNodata];
      var nodata = nodataText != null && String(nodataText).trim() !== "" ? Number(String(nodataText).trim().replace(/^nan$/i, "NaN")) : null;
      var names = bandNames(r.ifds[0][TAG.GdalMetadata], main.spp);
      var bands = [];
      for (var b = 0; b < main.spp; b++) if (b !== alpha) bands.push({ index: b, name: names[b] || "" });

      return {
        src: src, levels: levels, width: main.width, height: main.height,
        transform: t, crs: crs, nodata: nodata, alphaBand: alpha, bands: bands,
        dtype: (main.format === 3 ? "float" : main.format === 2 ? "int" : "uint") + main.bits,
        compression: COMPRESSION[main.compression],
        photometric: main.photometric,
        palette: main.spp === 1 && main.colormap && main.colormap.length === 3 * Math.pow(2, main.bits) ? main.colormap : null,
      };
    });
  }

  // Grid size for the display: the full image, scaled down to the limits.
  function gridSize(info) {
    var n = info.levels[0].spp;
    var f = Math.max(1, info.width / MAX_SIDE, info.height / MAX_SIDE, Math.sqrt(info.width * info.height * n / MAX_VALUES));
    return { width: Math.max(1, Math.round(info.width / f)), height: Math.max(1, Math.round(info.height / f)) };
  }

  // Reads the display grid: one Float32Array per band (NaN = no data), with
  // the grid's own geotransform. `opts.onProgress(fraction)` is called as
  // chunks are decoded; `opts.decodeImage` replaces the browser JPEG/WebP decoder.
  function readGrid(info, opts) {
    opts = opts || {};
    var size = gridSize(info), gw = size.width, gh = size.height;
    // The smallest level that still has at least the grid's resolution.
    var img = info.levels[0];
    info.levels.forEach(function (l) { if (l.width >= gw && l.height >= gh && l.width < img.width) img = l; });
    var spp = img.spp, nBands = info.bands.length;
    var colAt = new Int32Array(gw), rowAt = new Int32Array(gh);
    for (var i = 0; i < gw; i++) colAt[i] = Math.min(img.width - 1, Math.floor((i + 0.5) * img.width / gw));
    for (var j = 0; j < gh; j++) rowAt[j] = Math.min(img.height - 1, Math.floor((j + 0.5) * img.height / gh));
    var out = info.bands.map(function () { var a = new Float32Array(gw * gh); a.fill(NaN); return a; });
    var alpha = new Uint8Array(info.alphaBand >= 0 ? gw * gh : 0);

    // Grid columns/rows that fall in each tile column/row.
    function spans(at, tile, count) {
      var s = [];
      for (var k = 0; k < count; k++) s.push([at.length, 0]);
      for (var q = 0; q < at.length; q++) {
        var t = Math.floor(at[q] / tile);
        if (q < s[t][0]) s[t][0] = q;
        s[t][1] = q + 1;
      }
      return s;
    }
    var colSpans = spans(colAt, img.tileW, img.across), rowSpans = spans(rowAt, img.tileH, img.down);

    // Chunks to read. Planar files have one chunk per band per tile.
    var planes = img.planar === 2 ? spp : 1;
    var chunks = [];
    var rowBytesStrip = img.width * (img.planar === 2 ? 1 : spp) * img.bits / 8;
    for (var ty = 0; ty < img.down; ty++) {
      if (rowSpans[ty][1] <= rowSpans[ty][0]) continue;
      for (var tx = 0; tx < img.across; tx++) {
        if (colSpans[tx][1] <= colSpans[tx][0]) continue;
        for (var p = 0; p < planes; p++) {
          if (planes > 1 && p !== info.alphaBand && !info.bands.some(function (b) { return b.index === p; })) continue;
          var k = p * img.across * img.down + ty * img.across + tx;
          var base = { plane: p, tx: tx, ty: ty, offset: img.offsets[k], length: img.counts[k] };
          // Uncompressed strips: read only the rows the grid samples.
          if (img.compression === 1 && !img.tiled && img.tileH > 1) {
            for (var gj = rowSpans[ty][0]; gj < rowSpans[ty][1]; gj++) {
              if (gj > rowSpans[ty][0] && rowAt[gj] === rowAt[gj - 1]) continue;
              var r0 = rowAt[gj] - ty * img.tileH;
              chunks.push({ plane: p, tx: tx, ty: ty, row: rowAt[gj], offset: base.offset + r0 * rowBytesStrip, length: rowBytesStrip });
            }
          } else {
            chunks.push(base);
          }
        }
      }
    }
    chunks = chunks.filter(function (c) { return c.length > 0; });

    // Merge neighbouring byte ranges into reads of up to 16 MB.
    var sorted = chunks.slice().sort(function (a, b) { return a.offset - b.offset; });
    var reads = [];
    sorted.forEach(function (c) {
      var last = reads[reads.length - 1];
      if (last && c.offset >= last.end && c.offset - last.end < 65536 && c.offset + c.length - last.start <= 16 * 1024 * 1024) {
        last.end = Math.max(last.end, c.offset + c.length);
        last.chunks.push(c);
      } else {
        reads.push({ start: c.offset, end: c.offset + c.length, chunks: [c] });
      }
    });

    var nodata = info.nodata, bandOf = {};
    info.bands.forEach(function (b, n) { bandOf[b.index] = n; });
    var done = 0;

    function place(c, data) {
      // `data`: samples of the whole chunk (or of one strip row).
      var cw = img.tileW, oneRow = c.row != null;
      var x0 = c.tx * img.tileW, y0 = oneRow ? c.row : c.ty * img.tileH;
      var stride = img.planar === 2 ? 1 : spp;
      var gj, gi;
      var js = rowSpans[c.ty], is = colSpans[c.tx];
      for (gj = js[0]; gj < js[1]; gj++) {
        var ry = rowAt[gj] - y0;
        if (oneRow ? ry !== 0 : ry < 0) continue;
        var rowBase = (oneRow ? 0 : ry) * cw;
        for (gi = is[0]; gi < is[1]; gi++) {
          var px = (rowBase + colAt[gi] - x0) * stride, g = gj * gw + gi;
          for (var s = 0; s < stride; s++) {
            var band = img.planar === 2 ? c.plane : s;
            var v = Number(data[px + s]);
            if (band === info.alphaBand) { alpha[g] = v > 0 ? 1 : 2; continue; }
            var n = bandOf[band];
            if (n === undefined) continue;
            out[n][g] = (nodata != null && (v === nodata || (nodata !== nodata && v !== v))) ? NaN : v;
          }
        }
      }
    }

    function decodeChunk(c, bytes) {
      var w = img.tileW, h = c.row != null ? 1 : img.tiled ? img.tileH : Math.min(img.tileH, img.height - c.ty * img.tileH);
      var perRow = w * (img.planar === 2 ? 1 : spp);
      if (img.compression === 7 || img.compression === 50001) {
        return decodeBrowserChunk(img, bytes, w, img.tiled ? img.tileH : h, opts.decodeImage);
      }
      return decompress(img, bytes, perRow * h * img.bits / 8).then(function (raw) { return samples(img, raw, perRow, h); });
    }

    var queue = reads.slice(), active = [];
    function worker() {
      var r = queue.shift();
      if (!r) return Promise.resolve();
      return info.src.read(r.start, r.end - r.start).then(function (buf) {
        return r.chunks.reduce(function (prev, c) {
          return prev.then(function () {
            return decodeChunk(c, buf.subarray(c.offset - r.start, c.offset - r.start + c.length)).then(function (data) {
              place(c, data);
              done++;
              if (opts.onProgress) opts.onProgress(done / chunks.length);
            });
          });
        }, Promise.resolve());
      }).then(worker);
    }
    for (var w = 0; w < 4; w++) active.push(worker());
    return Promise.all(active).then(function () {
      if (alpha.length) {
        for (var g = 0; g < alpha.length; g++) if (alpha[g] === 2) out.forEach(function (a) { a[g] = NaN; });
      }
      var t = info.transform, sx = info.width / gw, sy = info.height / gh;
      return {
        width: gw, height: gh, bands: out,
        transform: [t[0], t[1] * sx, t[2] * sy, t[3], t[4] * sx, t[5] * sy],
        sourceWidth: img.width, sourceHeight: img.height,
      };
    });
  }

  // ---------- Statistics ----------
  // Percentiles from up to 200k evenly spaced valid values.
  function stats(values) {
    var step = Math.max(1, Math.floor(values.length / 200000)), list = [];
    for (var i = 0; i < values.length; i += step) { var v = values[i]; if (v === v && isFinite(v)) list.push(v); }
    if (!list.length) return null;
    var sorted = Float64Array.from(list).sort();
    function pct(p) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p / 100 * (sorted.length - 1))))]; }
    return { min: sorted[0], max: sorted[sorted.length - 1], p2: pct(2), p98: pct(98), count: sorted.length };
  }

  function normalizedDifference(a, b) {
    var out = new Float32Array(a.length);
    for (var i = 0; i < a.length; i++) {
      var s = a[i] + b[i];
      out[i] = s === 0 ? NaN : (a[i] - b[i]) / s;
    }
    return out;
  }

  // ---------- Colour ramps ----------
  // Stops from ColorBrewer and matplotlib (viridis, magma); interpolated to 256 colours.
  var RAMPS = {
    gray: { label: "Abu-abu", stops: ["#000000", "#ffffff"] },
    viridis: { label: "Viridis", stops: ["#440154", "#482878", "#3e4989", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"] },
    magma: { label: "Magma", stops: ["#000004", "#1c1044", "#4f127b", "#812581", "#b5367a", "#e55064", "#fb8761", "#fec287", "#fcfdbf"] },
    rdylgn: { label: "Merah–kuning–hijau", stops: ["#a50026", "#d73027", "#f46d43", "#fdae61", "#fee08b", "#ffffbf", "#d9ef8b", "#a6d96a", "#66bd63", "#1a9850", "#006837"] },
    spectral: { label: "Spektral", stops: ["#9e0142", "#d53e4f", "#f46d43", "#fdae61", "#fee08b", "#ffffbf", "#e6f598", "#abdda4", "#66c2a5", "#3288bd", "#5e4fa2"] },
    terrain: { label: "Elevasi", stops: ["#1a6e3a", "#58a65c", "#b8d68e", "#f2e7a8", "#d6b47c", "#a7795a", "#8c6c5f", "#ffffff"] },
    blues: { label: "Biru (air)", stops: ["#f7fbff", "#deebf7", "#c6dbef", "#9ecae1", "#6baed6", "#4292c6", "#2171b5", "#08519c", "#08306b"] },
  };
  function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  var rampCache = {};
  function ramp(name) {
    if (rampCache[name]) return rampCache[name];
    var stops = (RAMPS[name] || RAMPS.gray).stops.map(hex), lut = new Uint8Array(256 * 3);
    for (var i = 0; i < 256; i++) {
      var t = i / 255 * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(t)), f = t - k;
      for (var c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(stops[k][c] + (stops[k + 1][c] - stops[k][c]) * f);
    }
    return (rampCache[name] = lut);
  }

  // ---------- Rendering ----------
  // Colours the grid into `rgba` (Uint8ClampedArray, width*height*4).
  // style.mode:
  //   "rgb":     bands [r, g, b] (grid band numbers), ranges [[min, max] ×3]
  //   "single":  band, min, max, ramp, reverse
  //   "index":   values (Float32Array from normalizedDifference), min, max, ramp, reverse
  //   "palette": band, colormap (TIFF ColorMap, 16-bit)
  function render(grid, style, rgba) {
    var n = grid.width * grid.height, i, v, k;
    if (style.mode === "rgb") {
      var ch = style.bands.map(function (b) { return grid.bands[b]; });
      var lo = style.ranges.map(function (r) { return r[0]; });
      var sc = style.ranges.map(function (r) { return r[1] > r[0] ? 255 / (r[1] - r[0]) : 0; });
      for (i = 0; i < n; i++) {
        var r = ch[0][i], g = ch[1][i], b = ch[2][i];
        if (r !== r || g !== g || b !== b) { rgba[i * 4 + 3] = 0; continue; }
        rgba[i * 4] = (r - lo[0]) * sc[0];
        rgba[i * 4 + 1] = (g - lo[1]) * sc[1];
        rgba[i * 4 + 2] = (b - lo[2]) * sc[2];
        rgba[i * 4 + 3] = 255;
      }
      return rgba;
    }
    if (style.mode === "palette") {
      var cm = style.colormap, size = cm.length / 3, band = grid.bands[style.band];
      for (i = 0; i < n; i++) {
        v = band[i];
        if (v !== v || v < 0 || v >= size) { rgba[i * 4 + 3] = 0; continue; }
        rgba[i * 4] = cm[v] >> 8; rgba[i * 4 + 1] = cm[v + size] >> 8; rgba[i * 4 + 2] = cm[v + 2 * size] >> 8;
        rgba[i * 4 + 3] = 255;
      }
      return rgba;
    }
    var values = style.mode === "index" ? style.values : grid.bands[style.band];
    var lut = ramp(style.ramp), min = style.min, span = style.max - style.min, rev = !!style.reverse;
    for (i = 0; i < n; i++) {
      v = values[i];
      if (v !== v) { rgba[i * 4 + 3] = 0; continue; }
      var t = span > 0 ? (v - min) / span : 0.5;
      k = t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255);
      if (rev) k = 255 - k;
      rgba[i * 4] = lut[k * 3]; rgba[i * 4 + 1] = lut[k * 3 + 1]; rgba[i * 4 + 2] = lut[k * 3 + 2];
      rgba[i * 4 + 3] = 255;
    }
    return rgba;
  }

  // ---------- Web Mercator ----------
  var MAX_LAT = 85.0511;
  function lonLatBounds(grid, crs) {
    var w = grid.width, h = grid.height, t = grid.transform, b = [Infinity, Infinity, -Infinity, -Infinity];
    var steps = 32;
    function add(c, r) {
      var p = crs.toLonLat(t[0] + c * t[1] + r * t[2], t[3] + c * t[4] + r * t[5]);
      if (!isFinite(p[0]) || !isFinite(p[1])) return;
      b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]);
      b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]);
    }
    for (var s = 0; s <= steps; s++) {
      add(w * s / steps, 0); add(w * s / steps, h); add(0, h * s / steps); add(w, h * s / steps);
    }
    if (!(b[0] < b[2] && b[1] < b[3])) fail("coordinates are outside the world");
    if (b[0] < -180.5 || b[2] > 180.5 || b[1] < -90.5 || b[3] > 90.5) fail("coordinates are outside the world");
    b[1] = Math.max(b[1], -MAX_LAT); b[3] = Math.min(b[3], MAX_LAT);
    return b;
  }

  // Maps each pixel of a Web Mercator canvas covering the raster to a grid
  // index (-1 = outside), nearest neighbour.
  function mercatorLookup(grid, crs, maxSide) {
    maxSide = maxSide || 4096;
    var bb = lonLatBounds(grid, crs);
    var x0 = MERCATOR.fromLonLat(bb[0], bb[1]), x1 = MERCATOR.fromLonLat(bb[2], bb[3]);
    var aspect = (x1[0] - x0[0]) / (x1[1] - x0[1]);
    var px = grid.width * grid.height * 1.1;
    var ow = Math.max(1, Math.round(Math.sqrt(px * aspect))), oh = Math.max(1, Math.round(px / ow));
    var f = Math.max(1, ow / maxSide, oh / maxSide);
    ow = Math.max(1, Math.round(ow / f)); oh = Math.max(1, Math.round(oh / f));
    var t = grid.transform, det = t[1] * t[5] - t[2] * t[4];
    var lookup = new Int32Array(ow * oh), dx = (x1[0] - x0[0]) / ow, dy = (x1[1] - x0[1]) / oh;
    // Projecting every pixel is slow; project every STEP-th pixel of a row
    // exactly and interpolate in between (well under a pixel off).
    var STEP = 16, knots = Math.ceil(ow / STEP) + 1, kx = new Float64Array(knots), ky = new Float64Array(knots);
    for (var r = 0; r < oh; r++) {
      var my = x1[1] - (r + 0.5) * dy, lat = (2 * Math.atan(Math.exp(my / A)) - Math.PI / 2) / DEG;
      for (var k = 0; k < knots; k++) {
        var p = crs.fromLonLat((x0[0] + (Math.min(k * STEP, ow - 1) + 0.5) * dx) / A / DEG, lat);
        kx[k] = p[0] - t[0]; ky[k] = p[1] - t[3];
      }
      for (var c = 0; c < ow; c++) {
        var kk = Math.floor(c / STEP), c0 = kk * STEP, c1 = Math.min(c0 + STEP, ow - 1);
        var f = c1 > c0 ? (c - c0) / (c1 - c0) : 0;
        var ex = kx[kk] + (kx[kk + 1] - kx[kk]) * f, ey = ky[kk] + (ky[kk + 1] - ky[kk]) * f;
        var col = Math.floor((ex * t[5] - ey * t[2]) / det), row = Math.floor((ey * t[1] - ex * t[4]) / det);
        lookup[r * ow + c] = col >= 0 && col < grid.width && row >= 0 && row < grid.height ? row * grid.width + col : -1;
      }
    }
    return { width: ow, height: oh, lookup: lookup, bounds: [[bb[1], bb[0]], [bb[3], bb[2]]] };
  }

  function project(lookup, gridRgba, outRgba) {
    var src = new Uint32Array(gridRgba.buffer, gridRgba.byteOffset, gridRgba.length / 4);
    var dst = new Uint32Array(outRgba.buffer, outRgba.byteOffset, outRgba.length / 4);
    var lk = lookup.lookup;
    for (var i = 0; i < lk.length; i++) dst[i] = lk[i] < 0 ? 0 : src[lk[i]];
    return outRgba;
  }

  // Grid index under a longitude/latitude, or -1.
  function gridIndexAt(grid, crs, lon, lat) {
    var p = crs.fromLonLat(lon, lat), t = grid.transform, det = t[1] * t[5] - t[2] * t[4];
    var ex = p[0] - t[0], ey = p[1] - t[3];
    var col = Math.floor((ex * t[5] - ey * t[2]) / det), row = Math.floor((ey * t[1] - ex * t[4]) / det);
    return col >= 0 && col < grid.width && row >= 0 && row < grid.height ? row * grid.width + col : -1;
  }

  // Band roles from GDAL band descriptions (e.g. "B4 Red", "nir", "Merah").
  function guessBands(names) {
    var roles = {};
    var tests = {
      blue: /\b(blue|biru)\b|^b0?2\b/i,
      green: /\b(green|hijau)\b|^b0?3\b/i,
      red: /\b(red|merah)\b|^b0?4\b/i,
      nir: /\b(nir|near[ -]?infrared|inframerah dekat)\b|^b0?8\b/i,
    };
    names.forEach(function (n, i) {
      Object.keys(tests).forEach(function (role) { if (roles[role] == null && n && tests[role].test(n)) roles[role] = i; });
    });
    return roles;
  }

  return {
    open: open,
    readGrid: readGrid,
    gridSize: gridSize,
    stats: stats,
    normalizedDifference: normalizedDifference,
    render: render,
    ramp: ramp,
    RAMPS: RAMPS,
    mercatorLookup: mercatorLookup,
    project: project,
    gridIndexAt: gridIndexAt,
    guessBands: guessBands,
    epsg: epsg,
    tmForward: tmForward,
    lzw: lzw,
    packbits: packbits,
    LIMITS: { side: MAX_SIDE, values: MAX_VALUES },
  };
});
