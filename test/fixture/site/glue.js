// scramjet #185: the rewriter used to glue its wrapper onto these keywords
var __glue = { target: { postMessage: function () {} } };
function __glueReturn(a) {
	return(a).postMessage;
}
__glue.returnOk = typeof __glueReturn(__glue.target) === "function";
__glue.typeofOk = "function" === typeof(__glue.target).postMessage;
