var fs = require("fs");
var browserify = require("browserify");
var babelify = require("babelify");

browserify()
  .transform(babelify)
  .require("./src/index.js", { entry: true })
  .bundle()
  .on("error", function (err) { console.log("Error: " + err.message); })
  .pipe(fs.createWriteStream("./dist/bundle.min.js"));
