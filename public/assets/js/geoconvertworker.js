// Runs the converter (geoconvert.js) off the page's main thread, so the page
// stays responsive while a large file is read or written. The parsed data
// stays here between "read" and "write"; only a summary and the finished
// file (a Blob) go back to the page. Nothing is sent anywhere else.
importScripts("staticmap.js" + self.location.search, "geoconvert.js" + self.location.search);

var data = null;

self.onmessage = function (e) {
  var msg = e.data, job;
  if (msg.cmd === "read") {
    data = null; // let the previous file be freed before reading the next one
    job = GeoConvert.read(msg.files, msg.options).then(function (d) {
      data = d;
      return GeoConvert.summary(d);
    });
  } else if (msg.cmd === "write") {
    job = data ? GeoConvert.write(data, msg.format, msg.name).then(function (out) {
      return { blob: new Blob(out.parts, { type: out.mime }), filename: out.filename, warnings: out.warnings };
    }) : Promise.reject(new Error("Choose a file first."));
  } else if (msg.cmd === "limit") {
    job = Promise.resolve(GeoConvert.sizeLimit(msg.env));
  } else if (msg.cmd === "clear") {
    data = null;
    job = Promise.resolve(true);
  }
  if (!job) job = Promise.reject(new Error("Unknown command: " + msg.cmd));
  job.then(function (result) {
    self.postMessage({ id: msg.id, result: result });
  }, function (err) {
    self.postMessage({ id: msg.id, error: { message: String((err && err.message) || err), name: err && err.name } });
  });
};
