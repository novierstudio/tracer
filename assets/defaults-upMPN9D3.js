var e=1440,t={stpTimers:`fast`,routingTimers:`fast`},n=e=>e.settings??t,r={dns:{enabled:!1,records:[]},http:{enabled:!0,indexHtml:`<!doctype html>
<html>
  <head>
    <title>Tracer web server</title>
  </head>
  <body>
    <h1>It works!</h1>
    <p>This page is served by a Tracer server. Edit it in the server's Services tab.</p>
  </body>
</html>
`}},i=e=>e.services??r;export{n,i as r,e as t};