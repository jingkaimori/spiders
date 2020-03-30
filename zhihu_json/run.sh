echo 开始运行...

echo 清除旧文件...runn
function initDir(){
	if test -e $1 ;then {
		rm -r $1;
		mkdir $1;
	} else
		mkdir $1 \
	;fi
}
initDir data;
initDir imgs;
initDir logs;
echo 开始爬取...

node index.js