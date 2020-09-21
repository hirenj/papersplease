let papersplease = require('..');

let succeed = (res) => {
  console.log(res);
};

let fail = (err) => {
  console.error(err);
}

let key = 'google-1O-h_8rvRo6VgAcgCE9fu1Zxj34_e_Cvw'

let stamps = [].map( text => { return { text } });

let extracted = { stamps };

papersplease.setTags({key, extracted},{ succeed, fail } );
