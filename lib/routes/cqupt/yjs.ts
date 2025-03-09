import { DataItem, Route } from '@/types';
import InvalidParameterError from '@/errors/types/invalid-parameter';
import got from '@/utils/got';
import { load } from 'cheerio';
import timezone from '@/utils/timezone';
import { parseDate } from '@/utils/parse-date';
import cache from '@/utils/cache';
import { config } from '@/config';
import { CookieJar } from 'tough-cookie';
import puppeteer from '@/utils/puppeteer';
import logger from '@/utils/logger';

const yjsyPrefix = '重庆邮电大学研究生院';

const map: {
    [key: string]: {
        title: string;
        subTypes: {
            [key: string]: {
                title: string;
            };
        };
    };
} = {
    index: {
        title: '首页',
        subTypes: {
            xwkx: {
                title: '新闻快讯',
            },
        },
    },
    zsxx: {
        title: '招生信息',
        subTypes: {
            bszs: {
                title: '博士招生',
            },
            sszs: {
                title: '硕士招生',
            },
            zsjz: {
                title: '招生简章',
            },
            kdxx: {
                title: '考点信息',
            },
            lxwm: {
                title: '联系我们',
            },
        },
    },
    pygz: {
        title: '培养工作',
        subTypes: {
            xxfb: {
                title: '信息发布',
            },
            zcfg: {
                title: '政策法规',
            },
            xgxz: {
                title: '相关下载',
            },
            lhpyjd: {
                title: '联合培养基地',
            },
        },
    },
    xwgz: {
        title: '学位工作',
        subTypes: {
            swtz: {
                title: '事务通知',
            },
            gsgg: {
                title: '公示公告',
            },
            xwdjs: {
                title: '学位点建设',
            },
            zcfg: {
                title: '政策法规',
            },
            gcss: {
                title: '工程硕士',
            },
            xgxz: {
                title: '相关下载',
            },
        },
    },
    xsgz1: {
        title: '学生工作',
        subTypes: {
            tzgg: {
                title: '通知公告',
            },
            xywh: {
                title: '校园文化',
            },
            xsgl: {
                title: '学生管理',
            },
            xgxz: {
                title: '相关下载',
            },
        },
    },
    jyzd: {
        title: '就业指导',
        subTypes: {
            tzgg: {
                title: '通知公告',
            },
            xgzc: {
                title: '相关政策',
            },
            xgxz: {
                title: '相关下载',
            },
        },
    },
    zzjg: {
        title: '组织机构',
        subTypes: {
            bmld: {
                title: '部门领导',
            },
            kszz: {
                title: '科室职责',
            },
        },
    },
    zsxy: {
        title: '招生学院',
        subTypes: {},
    },
};

const host = 'https://yjs.cqupt.edu.cn';

export const route: Route = {
    path: '/yjs/:type?/:sub_type?',
    categories: ['university'],
    example: '/cqupt/yjs/zsxx/sszs',
    parameters: {
        type: '大分类，默认为 `index`',
        sub_type: '子分类，默认为 `index`，若设置为 `index` 则订阅整个大类',
    },
    features: {
        requireConfig: false,
        requirePuppeteer: true,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    name: '研究生院',
    maintainers: ['sgpublic'],
    handler,
    url: 'yjs.cqupt.edu.cn/',
    description: createTypeDescTable(),
};

async function handler(ctx) {
    const type = ctx.req.param('type') ?? 'index';
    const info = map[type];
    if (!info) {
        throw new InvalidParameterError('invalid type');
    }
    const subType = type === 'index' ? 'xwkx' : (ctx.req.param('sub_type') ?? 'index');

    const url: string = subType === 'index' ? `/${type}.htm` : `/${type}/${subType}.htm`;

    const cookieJar = await cache.tryGet('cqupt/yjs/cookie', async () => {
        let result: CookieJar | null = null;
        try {
            const browser = await puppeteer();
            const page = await browser.newPage();
            await page.setRequestInterception(true);
            page.on('request', (request) => {
                request.resourceType() === 'document' || request.resourceType() === 'script' ? request.continue() : request.abort();
            });
            logger.http(`Requesting ${host}${url}`);
            await page.goto(`${host}${url}`, {
                waitUntil: 'domcontentloaded',
            });
            await page.waitForNetworkIdle();

            result = new CookieJar();
            const cookies = await page.cookies();
            cookies.reduce((jar, cookie) => {
                jar.setCookie(`${cookie.name}=${cookie.value}`, host);
                return jar;
            }, result);
            // result.setCookie('enable_undefined=true', host);

            await browser.close();
        } catch {
            result = null;
        }
        return result;
    });
    logger.info(`typeof cookieJar: ${typeof cookieJar}`);

    let items: DataItem[];

    const response = await got.get({
        url: `${host}${url}`,
        cookieJar,
        headers: {
            'User-Agent': config.ua,
            Referer: `${host}${url}`,
        },
    });
    const $ = load(response.data);
    items = $('section.container > ul')
        .find('li')
        .toArray()
        .map((rawItem) => {
            const item = $(rawItem);
            const title = item.find('a').text().trim();
            const link = item.find('a').attr('href')?.startsWith('../info') ? host + item.find('a').attr('href')?.substring(2) : item.find('a').attr('href');
            const pubDate = timezone(parseDate(item.find('.time').text(), 'YYYY年MM月DD日'), +8);
            return {
                title,
                pubDate,
                link,
            };
        });

    items = await Promise.all(
        items.map((item) =>
            cache.tryGet(item.link, async () => {
                let desc: string | undefined = '';
                try {
                    const response = await got(item.link);
                    desc = load(response.data)('.Section0').html() ?? undefined;
                    item.description = desc;
                } catch {
                    // intranet only contents
                }
                return item;
            })
        )
    );

    return {
        title: `${yjsyPrefix} - ${info.title}${subType === 'index' ? '' : ` - ${info.subTypes[subType]}`}`,
        link: `${host}${url}`,
        item: items,
    };
}

function createTypeDescTable(): string {
    const table: string[] = [];
    table.push('| type | sub_type |', '| --- | --- |');
    for (const typeKey in map) {
        const typeItem = map[typeKey];

        const line: string[] = [];
        line.push(`| ${typeItem.title} | `);

        const subTypes: string[] = [];
        for (const subTypeKey in typeItem.subTypes) {
            const subTypeItem = typeItem.subTypes[subTypeKey];

            subTypes.push(`${subTypeItem}（${subTypeItem.title}）`);
        }
        if (subTypes.length <= 0) {
            line.push('（无）');
        } else {
            line.push(subTypes.join('<br />'));
        }

        table.push(line.join(''));
    }
    return table.join('\n');
}
