'use strict';
/*jshint esversion: 6, node:true */

const google = require('googleapis');
const fs = require('fs');
const uuid = require('uuid');

var bucket_name = 'test-gator';

var google_get_start_token = function() {
  var service = google.drive('v3');
  return new Promise(function(resolve,reject) {
    service.changes.getStartPageToken({},function(err,result) {
      if (err) {
        reject(err);
        return;
      }
      var startPageToken = result.startPageToken;
      resolve(startPageToken);
    });
  });
};

var google_request_hook = function(hook_url,token) {
  var service = google.drive('v3');
  return new Promise(function(resolve,reject) {
    service.changes.watch({
    pageToken: token,
    resource: {
      id: uuid.v1(),
      type: 'web_hook',
      address: hook_url
    }},function(err,result) {
      if (err) {
        reject(err);
        return;
      }
      result.page_token = token;
      resolve(result);
    });
  });
};

var google_register_hook = function(hook_url) {
  return google_get_start_token().then(function(startPageToken) {
    return google_request_hook(hook_url,startPageToken);
  });
};

var google_get_file_if_needed = function(file) {
  return google_get_file_if_needed_s3(file);
}

var check_existing_file_s3 = function(file) {
  var AWS = require('lambda-helpers').AWS;
  var s3 = new AWS.S3();
  var params = {
    Bucket: bucket_name,
    Key: 'uploads/google-' +file.id,
    IfNoneMatch: '"'+file.md5+'"'
  };
  return new Promise(function(resolve,reject) {
    s3.headObject(params, function(err, data) {
      if (err) {

        if (err.statusCode >= 500) {
          reject(err);
          return;
        }

        if (err.statusCode == 304) {
          console.log("Already uploaded");
          resolve(true);
          return;
        }
        if (err.statusCode == 403) {
          console.log("File doesn't exist");
          resolve(file);
          return;
        }
        if (err.statusCode == 404) {
          console.log("No file, need to upload");
          resolve(file);
          return;
        }
        reject(err);
        return;
      } else {
        resolve(file);
      }
    });
  });
};

var google_get_file_if_needed_s3 = function(file) {
  var drive = google.drive('v3');
  console.log("Getting file from google",file.id," md5 ",file.md5);
  return check_existing_file_s3(file).then(function(exists) {
    if (exists === true) {
      return true;
    }
    var AWS = require('lambda-helpers').AWS;
    var s3 = new AWS.S3();

    var params = {
      Bucket: bucket_name,
      Key: 'uploads/google-' +file.id
    };
    console.log("Trying upload to S3");
    var in_stream = drive.files.get({
      'fileId' : file.id ,
      'alt' : 'media'
    });
    var stream = new require('stream').PassThrough();
    in_stream.pipe(stream);
    params.Body = stream;
    params.ContentMD5 = new Buffer(file.md5,'hex').toString('base64');
    var options = {partSize: 15 * 1024 * 1024, queueSize: 1};
    return new Promise(function(resolve,reject) {
      s3.upload(params, options,function(err,data) {
        if (err) {
          reject(err);
          return;
        }
        resolve(data);
      });
    });
  });
};

var google_get_file_if_needed_local = function(file) {
  var service = google.drive('v3');
  return new Promise(function(resolve,reject) {
    fs.lstat(file.id+'.msdata.json',function(err,stats) {
      if (! err) {
        // Skip checking MD5
        return resolve(true);
      }
      console.log("Downloading "+file.name,file.id);
      var dest = fs.createWriteStream(file.id+'.msdata.json');

      service.files.get({
        'fileId' : file.id ,
        'alt' : 'media'
      }).on('end',resolve).on('error',reject).pipe(dest);
    })
  });
};

const get_changed_files = (page_token,files) => {
  var service = google.drive('v3');
  if ( ! files ) {
    files = [];
  }
  if (page_token == 'none') {
    return google_get_start_token().then(token => google_get_changed_files(token,files));
  }
  return new Promise(function(resolve,reject) {
    service.changes.list({pageToken: page_token },function(err,result) {
      if (err) {
        reject(err);
        return;
      }
      console.log("Changes",JSON.stringify(result.changes.map(function(file) {
        return { id: file.fileId, removed: file.removed, name : file.file.name };
      })));
      var current_files = result.changes.filter(function(file) {
        return ! file.removed && file.file.fileExtension.match(/\.pdf$/);
      }).map(function(file) {
        return file.fileId;
      });
      if (result.nextPageToken) {
        resolve(google_get_changed_files(result.nextPageToken,files.concat(current_files)));
        return;
      }
      if (result.newStartPageToken) {
        console.log("New start page token should be ",result.newStartPageToken);
        // Update the triggers with the new start page token
        resolve({ files: files.concat(current_files), token: result.newStartPageToken });
      }
    });
  });
};

var getChangedFiles = function getChangedFiles(page_token) {
  return getServiceAuth().then( () => get_changed_files(page_token) );
};

var registerHook = function registerHook(hook_url) {
  return getServiceAuth().then( () => google_register_hook(hook_url) );
};

var downloadFileIfNecessary = function downloadFileIfNecessary(file) {
  console.log("We have no auth token, trying to get a fresh auth");
  return getServiceAuth().then( () => google_get_file_if_needed(file) );
};

var getServiceAuth = function getServiceAuth() {

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_API_KEY,
    process.env.GOOGLE_API_SECRET
  );

  oauth2client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN
  });

  // set auth as a global default
  google.options({
    auth: oauth2Client
  });
};

exports.setRootBucket = function(bucket) {
  bucket_name = bucket;
};
exports.registerHook = registerHook;
exports.downloadFileIfNecessary = downloadFileIfNecessary;
exports.getFiles = getFiles;
exports.getChangedFiles = getChangedFiles;
exports.getServiceAuth = getServiceAuth;
exports.getGroups = getGroups;