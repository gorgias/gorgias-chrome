import {expect} from 'chai';

import {htmlToText} from './plain-text';

describe('htmlToText', () => {
    it('should convert html to text', () => {
        expect(htmlToText('<div>first-line<div>second-line</div>third-line</div>')).equal('first-line\nsecond-line\nthird-line');
    });

    it('should add end newlines to block nodes', () => {
        expect(htmlToText('<div><div>first</div>second</div>')).equal('first\nsecond');
    });

    it('should add correct newlines to successive block nodes', () => {
        expect(htmlToText('<div>first</div><div>second</div>')).equal('first\nsecond');
    });

    it('should add newlines for br and divs', () => {
        expect(htmlToText('<div>first<br></div><br><div>second</div><br>third')).equal('first\n\n\nsecond\n\nthird');
    });

    it('should add newlines for br inside inline nodes', () => {
        expect(htmlToText('<span>first<br></span>second')).equal('first\nsecond');
    });

    it('should remove extra newlines from html', () => {
        expect(htmlToText('<div>first</div>\n\n<div>second</div>')).equal('first\nsecond');
    });

    it('should keep plain text links intact', () => {
        expect(htmlToText('https://www.gorgiastemplates.com/')).equal('https://www.gorgiastemplates.com/');
    });

    it('should keep plain text the same', () => {
        const content = 'line-one\n* bullet\nlink(https://gorgiastemplates.com';
        expect(htmlToText(content)).equal(content);
    });

    it('should decorate lists', () => {
        expect(htmlToText('<ul><li>one</li><li>two</li</ul>')).equal(' * one\n * two');
    });

    it('should decorate links', () => {
        expect(htmlToText('<a href="https://gorgiastemplates.com/">gorgiastemplates</a>')).equal('gorgiastemplates [https://gorgiastemplates.com/]');
    });

    it('should decorate links only with different urls', () => {
        expect(htmlToText('<a href="https://gorgiastemplates.com/">https://gorgiastemplates.com/</a>')).equal('https://gorgiastemplates.com/');
    });

    it('should decorate images', () => {
        expect(htmlToText('<img src="https://gorgiastemplates.com/image.jpg" alt="image alt">')).equal('image alt [https://gorgiastemplates.com/image.jpg]');
    });

    it('should add newlines for br tags', () => {
        expect(htmlToText('first<br /><br />second<br><br>third')).equal('first\n\nsecond\n\nthird');
    });
});
