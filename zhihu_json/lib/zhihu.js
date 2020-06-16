/**
 * Created by qieguo on 2016/9/28.
 * 整体思路：
 * 通过cookie登录，爬取第一页数据并获取xsrf码，然后使用cookie和xsrf码来请求分页数据。
 * 每一页的数据都保存到一个以时间戳为名字的json文件中，以此完成数据的持久化。
 * 下载图片的时候先读取json文件，获取图片途径再进行下载，串行下载每个user的图片。
 * 请求分页数据的并发设置为5，图片下载的并发设置为10。
 * 
 * 
 * 2020年3月31日
 * - 更新：HTML中没有xsrf数据
 * - 此时的xsrf属性名不再是X-，而是_xsrf。
 * - 不提供_xsrf和cookie也可以使用API，故不必要处理_xsrf
 */

'use strict';

const request = require('superagent');
//require('superagent-proxy')(request);   // extend with Request#proxy()
const cookie = require('cookie');
const async = require('async');
const util = require('util');
const fs = require('fs');
const path = require('path');

const config = require('../config');
const logger = require('./logger');

const DATADIR = path.join(__dirname, '../data');
const IMGDIR = path.join(__dirname, '../imgs');
;

let cookies = config.cookies[0];
let userAgent = config.userAgent[0];
//let proxy = config.proxy[0];

function toCookieObj(cookieInput) {
  let result = [];
  if (util.isArray(cookieInput)) {
    for (let el of cookieInput) {
      result.push(el.split(';')[0]);
    }
    return cookie.parse(result.join(';'));
  } else {
    return cookie.parse(cookieInput);
  }
}

function toCookieStr(cookieObj) {
  let result = '';
  for (let el in cookieObj) {
    result += el.toString() + '=' + cookieObj[el].toString() + '; ';
  }
  return result;
}
/**
 * 分页查询类，使用js方式构造。
 * @param {Number} offset 
 * @member {number} token    问题token
 * @member {string} url      分页请求路径
 * @member {number} reqParam get请求参数
 */
function Page(type,offset){
  
  this.token=config.questionToken;
  this.reqParam={
    offset : offset||0,
    limit : Page.size,
    platform : "desktop",
    sort_by : "default"
  };
  this.url = 
  'https://www.zhihu.com/api/v4/questions/' + this.token + '/answers?' + this.parseReq();
}
Page.size=5;
Page.prototype.parseReq=function (){
  let result = '';
  for (let el in this.reqParam) {
    result += el.toString() + '=' + this.reqParam[el].toString() + '&';
  }
  return result;
};

function errHandler(err,messageSuccess,messageError,callback){
  if (err) {
    if(messageError){
      logger.error(messageError, err);
    }
    callback(err);
  } else {
    if(messageSuccess){
      logger.debug(messageSuccess);
    }
    callback();
  }
}
function saveData(err,data,cb){
  if (err) {
    logger.error('save page error: ', err);
    return cb(err);
  } 
  
  // 出错也不应该终止程序，所以外围函数要捕获这个err保证下一次调用继续执行
  let file = path.join(DATADIR, Date.now().toString().substr(5, 9) + '.json');
  let output=[];
  for(var item in data.data){
    output.push(data.data[item]);
  }
  fs.writeFile(file, JSON.stringify(output), 'utf-8',(err) => {
    errHandler(err,'save page successfully','save page error: ',cb);
  });
}
/**
 * 爬取分页数据
 * 注意异常处理，后面分页抓取的时候遇到异常不应该终止程序，而是应该捕获异常继续往下走
 * 同理，数据库操作异常也一样不能终止程序，但是要注意将出错信息记录下来。
 * HTML文本里没有xsrf
 * @param {Page} opt 分页配置
 * @param {function(Error,Object,function(Error))} dataHandler 数据处理回调函数，
 * - err: 出错信息，外围程序应该捕获这个err，不要让它终止了整个程序
 * - data: 
 * - callback:
 * @param {function(Error)} dataCallback 控制流跳出回调函数
 */
function fetchPage(opt, dataHandler,dataCallback) {
  //let xsrf = toCookieObj(cookies)._xsrf;
  //let params = JSON.stringify({ "url_token": opt.token, "pagesize": opt.size || Page.size, "offset": opt.offset });
  request
    .get(opt.url)
    .set('Content-Type', 'text/json; charset=UTF-8')
    .set('User-Agent', userAgent)
    .end(function (err, resp) {
      if (err) {
        // 出错也不应该终止程序，所以外围函数要捕获这个err保证下一次调用继续执行
        logger.error('request error: ', err);
        return dataHandler(err,null,dataCallback);
      }
      let data = resp.body;
      let cksObj = toCookieObj(resp.headers['set-cookie']);
      let oldcks = toCookieObj(cookies);
      cksObj._xsrf = cksObj._xsrf || oldcks._xsrf;
      cookies = toCookieStr(Object.assign({}, oldcks, cksObj));
      return dataHandler(null,data,dataCallback);
    });
}
/**
 * 解析第一页数据
 * 同理，数据库操作异常也一样不能终止程序，但是既然是首页，还是抛出的好。
 * @param {Error} err 之前操作的错误
 * @param {object} data 爬取的对象数据
 * @param {function(Error,Number)} cb 回调函数
 * - err: 出错信息，终止整个程序
 */
function getnum(err, data,cb) {
  if(err){
    logger.error('fetch first page fail');
    return cb(err);
  }else if(!(data.paging&&data.paging.totals)){
    const nerr=new Error("No answer_count property in data");
    logger.error('fetch first page fail' ,nerr);
    return cb(nerr);
  }else{
    logger.debug('fetch first page successfully');
    return cb(null,data.paging.totals);
  }
}
/**
 * 爬取数据入口函数
 * 分页爬取控制最大并发数为5
 * @param {function(Error)} cb，回调函数，
 * - err: 出错信息
 */
async function startFetch(cb) {
  var firstPage = new Page(0);
  try{
    var num = await fetchPage(firstPage,getnum);
    let opts = [];
    num = Math.ceil(num / Page.size);
    for (let i = 0; i < num; i++) {
      opts.push(new Page("",i*Page.size));
    }
    logger.debug('page num: ', num);
    // 开始爬取其他页面，控制最大并发数为5，这里出错不调用cb
  }catch(err){
    // 第一页出错应该终止程序并抛出异常
    cb(err);
  }
  
  async.eachLimit(opts, 5, function (opt, callback) {
    // 加点随机性，模仿人类操作
    let delay = parseInt((Math.random() * 30000000) % 2000);
    setTimeout(function () {
      logger.debug('------  start fetch page  ------');
      // 无论是否有err，都要保证函数执行下去！所以不能callbace(err)
      // err应该用其他方法收集起来，这里暂不做
      fetchPage(opt,saveData,callback);
    }, delay);
  }, (err)=>{
    errHandler(err,'======  finish fetch all  ======',null,cb);
  });
}

/**
 * 下载单个user的图片，目前API只能获取用户头像
 * 这里控制并发数量为 10
 * @param {object} user 用户对象
 * @param {function(Error)} cb 回调函数
 * - err: 出错信息
 */
function loadImgs(user, cb) {
  if (!user.avatar_url) {
    cb(new Error('Invalid path'));
  } else {
    let img=user.avatar_url;
    let fileName = (user.name || '匿名') + Date.now().toString().substr(5, 8) + path.extname(img);
    let writeStream = fs.createWriteStream(path.join(IMGDIR, fileName));
    let req = request.get(img);
    logger.debug('>>>>  start load: ' + fileName);
    req.on('error', (err) => {
      logger.debug('----  fail load: ' + fileName);
      cb();
    });
    req.on('end', () => {
      logger.debug('----  finish load: ' + fileName);
      cb();
    });
    req.pipe(writeStream);
  }
  
}

/**
 * 下载一批data的图片
 * 这里控制按单个user串行爬取的方式
 * @param {function} cb，回调函数，
 * - err: 出错信息
 */
function loadUsers(items, cb) {
  async.eachSeries(items, function (item, callback) {
    // 报错也不要终止程序执行
    loadImgs(item.author, (err) => { callback();});
  },(err)=> {
    errHandler(err,null,null,cb);
  });
}

/**
 * 图片下载入口函数
 * @param {function} cb，回调函数，
 * - err: 出错信息
 */
function startLoad(cb) {
  fs.readdir(DATADIR, function (err, files) {
    if (err) {
      logger.error('read dir error: ', err);
      return cb(err);
    }
    async.eachSeries(files, function (file, callback) {
      // 报错也不要终止程序执行
      fs.readFile(path.join(DATADIR, file), function (err, data) {
        if (err) {
          logger.error('read file error: ', err);
          return callback();
        }
        logger.debug('read file: ', file);
        data = JSON.parse(data);
        loadUsers(data,  callback );
      });
    }, (err)=>{
      errHandler(err,null,null,cb)
    });
  })
}

exports.startFetch = startFetch;
exports.startLoad = startLoad;

