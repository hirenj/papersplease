// ./run_script.sh node test/test_set_tags_on_file.js

let papersplease = require('..');

let succeed = (res) => {
  console.log(res);
};

let fail = (err) => {
  console.error(err);
}

let key = 'google-1IJY8EIOC2DGBNtLkYOQX1i6xlxmMCZQJ'

let stamps = [].map( text => { return { text } });

let extracted = { stamps };

papersplease.setTags({key, extracted},{ succeed, fail } );
