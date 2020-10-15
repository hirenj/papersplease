
let google = require('../js/google');

let succeed = (res) => {
  console.log(res);
};

let fail = (err) => {
  console.error(err);
}

// Run once with the argument 'none' to get the start token, and
// then put the start token in, and modify the file

google.getChangedFiles('883472').then( res => console.log(res));
