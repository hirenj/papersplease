'use strict';
/*jshint esversion: 6, node:true */

let download_queue = 'https://sqs.us-east-1.amazonaws.com/978536629153/papersplease-DownloadQueue';
let bucket_name = 'papersplease-papers';
let download_queue_machine = '';

let config = {};

if (process.env.DOWNLOAD_QUEUE) {
  download_queue = process.env.DOWNLOAD_QUEUE;
}
if (process.env.DOWNLOAD_QUEUE_MACHINE) {
  download_queue_machine = process.env.DOWNLOAD_QUEUE_MACHINE;
}
if (process.env.BUCKET_NAME) {
  bucket_name = process.env.BUCKET_NAME;
}
const HOST_URL = (process.env.HOST_URL || '');

if (config.region) {
  require('lambda-helpers').AWS.setRegion(config.region);
}

const Queue = require('lambda-helpers').queue;
const google = require('./js/google');
const Events = require('lambda-helpers').events;

google.setRootBucket(bucket_name);

const download_changed_files = function(page_token) {
  return google.getChangedFiles(page_token);
};

const update_page_token = function(page_token) {
  const AWS = require('lambda-helpers').AWS;
  const s3 = new AWS.S3();
  var params = {
    Bucket: bucket_name,
    Key: 'config/page_token',
    Body: JSON.stringify({page_token: page_token})
  };
  console.log(params);
  return s3.putObject(params).promise();
};

const get_page_token = function() {
  const AWS = require('lambda-helpers').AWS;
  const s3 = new AWS.S3();
  var params = {
    Bucket: bucket_name,
    Key: 'config/page_token'
  };
  return s3.getObject(params).promise().then( data => {
    return JSON.parse(data.Body.toString());
  }).catch( err => {
    console.log('Did not get page token',err.message,err.statusCode);
    return { page_token: 'none' };
  });
};

const update_hook_conf = function(conf) {
  const AWS = require('lambda-helpers').AWS;
  const s3 = new AWS.S3();
  var params = {
    Bucket: bucket_name,
    Key: 'config/hook',
    Body: JSON.stringify(conf)
  };
  console.log(params);
  return s3.putObject(params).promise();
};

const get_hook_conf = function() {
  const AWS = require('lambda-helpers').AWS;
  const s3 = new AWS.S3();
  var params = {
    Bucket: bucket_name,
    Key: 'config/hook'
  };
  return s3.getObject(params).promise().then( data => {
    return JSON.parse(data.Body.toString());
  }).catch( err => {
    return {};
  });
};


const runDownloader = function() {
  if (process.env.DISABLE_QUEUE_PROCESSING !== 'false') {
    return Promise.resolve();
  }

  const AWS = require('lambda-helpers').AWS;
  const stepfunctions = new AWS.StepFunctions();

  let params = {
    stateMachineArn: download_queue_machine,
    input: '{}',
    name: ('DownloadQueue '+(new Date()).toString()).replace(/[^A-Za-z0-9]/g,'_')
  };
  return stepfunctions.listExecutions({ stateMachineArn: download_queue_machine, statusFilter: 'RUNNING'}).promise().then( running => {
    if (running.executions && running.executions.length > 0) {
      throw new Error('Already running');
    }
  })
  .then( () => stepfunctions.startExecution(params).promise())
  .catch( err => {
    if (err.message === 'Already running') {
      return;
    }
    throw err;
  });
};

exports.googleWebhook = function acceptWebhook(event,context) {
  let action_promise = Promise.resolve();

  if (process.env.DISABLE_WEBHOOK_ACTION === 'false') {
    action_promise = new Promise( resolve => {
      exports.queueDownloads({},{ succeed: resolve });
    })
    .then( (res) => {
      if (process.env.DISABLE_QUEUE_PROCESSING === 'false') {
        if (res && res.count > 0) {
          return runDownloader();
        }
      }
    });
  }

  action_promise.then( () => context.succeed({
        isBase64Encoded: false,
        statusCode: 200,
        headers : {},
        body: JSON.stringify({'status': 'OK'})
      }))
  .catch( err => context.fail(err) );
};

exports.queueDownloads = function queueDownloads(event,context) {

  let queue = new Queue(download_queue);
  var download_promise = Promise.resolve(true);

  download_promise = get_page_token()
  .then( token => download_changed_files(token.page_token) )
  .then((fileinfos) => {
    return update_page_token(fileinfos.token).then( () => fileinfos.files );
  });

  let file_count = 0;

  // Push all the shared files into the queue
  download_promise.then(function(files) {
    console.log("Files to download ",files);
    // We should increase the frequency the download daemon runs here
    if (files.length == 0) {
      return Promise.resolve(false);
    }
    console.log("Queueing files for download");
    return Promise.all(files.map((file) => {
      file_count += 1;
      console.log('Message',{'id' : file.id, 'name' : file.name, 'md5' : file.md5Checksum, 'size' : parseInt(file.size) });
      return queue.sendMessage({'id' : file.id, 'name' : file.name, 'md5' : file.md5Checksum, 'size' : parseInt(file.size) });
    }));
  }).then(function() {
    context.succeed({ count: file_count });
  }).catch(function(err) {
    console.error(err,err.stack);
    context.succeed({ count: 0 });
  });
};

exports.setTags = function(event,context) {
  let filename = event.key;
  let fileId = filename.replace(/.*google\-/,'');
  let tags = (event.extracted.stamps || []).map( stamp => stamp.text );
  let lc_tags = tags.map( tag => tag.toLowerCase() );
  console.log('Setting tags for ',fileId,tags);
  if (lc_tags.indexOf('inbox') >= 0) {
    console.log('Removing other tags because of inbox tag');
    tags = [];
  }
  google.setTagsForFileId( fileId, tags ).then( () => {
    console.log('Set tags');
    context.succeed(event);
  }).catch( err => {
    context.fail(err.message);
  });
};

exports.downloadFiles = function downloadFiles(event,context) {
  console.log("Lambda downloadFiles execution");

  let auth_data = null;

  const have_auth = google.getServiceAuth();

  const queue = new Queue(download_queue);

  const count = 1;

  have_auth.then(() => {

    return queue.shift(count);

  }).then(function(messages) {
    if (messages.length < 1 ) {
      throw new Error('No messages');
    }
    return Promise.all(messages.map(function(message) {
      let file = JSON.parse(message.Body);
      console.log(file.name,file.id);
      return google.downloadFileIfNecessary({
        'id' : file.id,
        'auth_token' : auth_data,
        'md5' : file.md5,
        'size' : file.size,
        'name' : file.name,
        'groupid' : file.group
      }).catch(err => {
        if (err.message !== 'BadMD5') {
          throw err;
        }
      }).then( downloaded => {
        queue.finalise(message.ReceiptHandle);
      });
    }));
  }).catch(function(err) {
    if (err.message === 'No messages') {
      console.log("No messages");
      context.succeed({messageCount: 0});
    } else {
      console.error('Caught error',err);
      console.error('Caught error',err.stack);
      context.fail(JSON.stringify({error: err.message}));
    }
  }).then(function() {
    context.succeed({ messageCount: 1 });
  });
};

exports.subscribeWebhook = function(event,context) {
  get_page_token().then( token => {
    get_hook_conf().then( hook_conf => {
      google.stopHook(hook_conf)
      .catch( err => console.log('Removing existing error',err.code) )
      .then( () => google.registerHook(HOST_URL+'/google',token.page_token))
      .then( res => {
        console.log("Expiration in ",res.expiration);
        return update_hook_conf(res);
      })
      .then( res => {
        context.succeed({'status': 'OK'});
      })
      .catch( err => context.fail(err.message));
    });
  });
};