import YtDlpWrap from 'yt-dlp-wrap';
console.log('Imported YtDlpWrap:', YtDlpWrap);
console.log('Type of YtDlpWrap:', typeof YtDlpWrap);
try {
    new YtDlpWrap('test');
    console.log('Constructor works');
} catch (e) {
    console.log('Constructor failed:', e);
}
