"use strict";

module.exports = Object.freeze([
  {
    packageName: "@supabase/supabase-js",
    source: "node_modules/@supabase/supabase-js/dist/umd/supabase.js",
    destination: "vendor/supabase.js",
  },
  {
    packageName: "@supabase/supabase-js",
    source: "node_modules/@supabase/supabase-js/LICENSE",
    destination: "vendor/supabase.js.LICENSE.txt",
  },
  {
    packageName: "html2pdf.js",
    source: "node_modules/html2pdf.js/dist/html2pdf.bundle.min.js",
    destination: "vendor/html2pdf.bundle.min.js",
  },
  {
    packageName: "html2pdf.js",
    source: "node_modules/html2pdf.js/dist/html2pdf.bundle.min.js.LICENSE.txt",
    destination: "vendor/html2pdf.bundle.min.js.LICENSE.txt",
  },
]);
